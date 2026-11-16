/**
 * gateway 전용 프로세스의 호가 복제본.
 *
 * gateway는 매칭 엔진이 없으므로, 구독 직후 보낼 스냅샷을 위해 market의 호가를 따라간다.
 * 처음에 market에서 스냅샷(GET /book)을 받고, 그 뒤로는 버스의 변경분을 seq 순서대로 반영한다.
 * 클라이언트(C++ BookSync)와 같은 규칙: seq가 last+1일 때만 반영, qty는 새 잔량(0 = 삭제),
 * 누락이 보이면 스냅샷을 다시 받는다. 받는 동안 온 변경분은 모았다가 스냅샷 뒤의 것만 반영한다.
 */
import type { DeltaMessage, SnapshotMessage, StatusMessage, WireLevel } from '../protocol.js';
import type { SnapshotProvider } from './gateway.js';

interface SymbolBook {
  bids: Map<number, number>;
  asks: Map<number, number>;
  seq: number;
  live: boolean;
  loading: boolean;
  pending: DeltaMessage[];
}

export type FetchJson = (url: string) => Promise<unknown>;

const DEPTH = 20;

export class BookReplica implements SnapshotProvider {
  private readonly books = new Map<string, SymbolBook>();
  resyncs = 0;
  /** 버스 지연 표본(시세에 찍힌 시각 → 이 gateway가 받은 시각, ms). 최근 1,000개 */
  private readonly lags: number[] = [];
  /** 종목별 최신 매매 상태(버스의 status 원문). 처음엔 market에서 받는다 */
  private readonly statuses = new Map<string, StatusMessage>();

  constructor(
    private readonly marketUrl: string,
    private readonly fetchJson: FetchJson = async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return res.json();
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** market의 종목 목록을 받아 모든 종목의 스냅샷을 채운다 */
  async start(): Promise<void> {
    const symbols = (await this.fetchJson(`${this.marketUrl}/symbols`)) as { code: string }[];
    for (const { code } of symbols) {
      this.books.set(code, { bids: new Map(), asks: new Map(), seq: 0, live: false, loading: false, pending: [] });
    }
    await Promise.all([...symbols.map(({ code }) => this.load(code)), this.loadStatus()]);
  }

  /** 버스에서 받은 매매 상태 */
  onStatus(symbol: string, payload: string): void {
    if (!this.books.has(symbol)) return;
    this.statuses.set(symbol, JSON.parse(payload) as StatusMessage);
  }

  status(symbol: string): StatusMessage | undefined {
    return this.statuses.get(symbol);
  }

  private async loadStatus(): Promise<void> {
    try {
      const list = (await this.fetchJson(`${this.marketUrl}/market/status`)) as StatusMessage[];
      for (const s of list) this.statuses.set(s.sym, s);
    } catch {
      // 다음 상태 변화가 버스로 오면 채워진다
    }
  }

  /** 버스에서 받은 시세 원문(book 종류만) */
  onBook(symbol: string, payload: string): void {
    const book = this.books.get(symbol);
    if (!book) return;
    const msg = JSON.parse(payload) as DeltaMessage | SnapshotMessage;
    if (msg.t !== 'delta') return;
    if (this.lags.length >= 1_000) this.lags.shift();
    this.lags.push(this.now() - msg.ts);
    if (!book.live) {
      book.pending.push(msg);
      return;
    }
    if (msg.seq <= book.seq) return;
    if (msg.seq !== book.seq + 1) {
      book.live = false;
      book.pending.push(msg);
      void this.load(symbol);
      return;
    }
    this.apply(book, msg);
  }

  /** 버스 구독이 끊겼다 붙음 → 놓친 변경분이 있을 수 있으니 전부 다시 받는다 */
  resyncAll(): void {
    void this.loadStatus();
    for (const [symbol, book] of this.books) {
      book.live = false;
      void this.load(symbol);
    }
  }

  /** 최근 버스 지연 p50·p99(ms). market → Redis → gateway 구간이 밀리는지 본다 */
  busLag(): { p50: number; p99: number; samples: number } {
    const sorted = [...this.lags].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    return { p50: q(0.5), p99: q(0.99), samples: sorted.length };
  }

  has(symbol: string): boolean {
    return this.books.has(symbol);
  }

  isLive(symbol: string): boolean {
    return this.books.get(symbol)?.live ?? false;
  }

  snapshot(symbol: string): SnapshotMessage {
    const book = this.books.get(symbol)!;
    const top = (side: Map<number, number>, desc: boolean): WireLevel[] =>
      [...side.entries()].sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).slice(0, DEPTH);
    return { t: 'snap', sym: symbol, seq: book.seq, ts: this.now(), bids: top(book.bids, true), asks: top(book.asks, false) };
  }

  private apply(book: SymbolBook, msg: DeltaMessage): void {
    const side = msg.side === 'B' ? book.bids : book.asks;
    if (msg.qty > 0) side.set(msg.px, msg.qty);
    else side.delete(msg.px);
    book.seq = msg.seq;
  }

  private async load(symbol: string): Promise<void> {
    const book = this.books.get(symbol);
    if (!book || book.loading) return;
    book.loading = true;
    this.resyncs += 1;
    try {
      // 시뮬레이터 호가는 기준가 ±수십 틱 안이라 50단계면 화면에 보낼 20단계를 덮는다
      const snap = (await this.fetchJson(`${this.marketUrl}/book/${symbol}?depth=50`)) as SnapshotMessage;
      book.bids = new Map(snap.bids);
      book.asks = new Map(snap.asks);
      book.seq = snap.seq;
      // 받는 동안 쌓인 변경분 중 스냅샷 이후 것만 이어 붙인다
      const pending = book.pending.filter((d) => d.seq > snap.seq).sort((a, b) => a.seq - b.seq);
      book.pending = [];
      book.live = true;
      for (const d of pending) {
        if (d.seq !== book.seq + 1) {
          book.live = false;
          break;
        }
        this.apply(book, d);
      }
    } catch {
      book.live = false;
    } finally {
      book.loading = false;
    }
    if (!book.live) setTimeout(() => void this.load(symbol), 500).unref();
  }
}
