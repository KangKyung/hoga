/**
 * 비교 실험의 "JS 경유" 버전이 쓰는 호가 장부.
 *
 * C++ BookSync와 같은 규칙(seq가 last+1일 때만 반영, delta의 qty는 새 잔량)을 JS로 다시 구현한 것이다.
 * 일반적인 RN 앱처럼 메시지마다 JSON.parse → 장부 갱신 → 정렬 → setState를 JS 스레드에서 한다.
 * 앱의 실제 화면은 이 코드를 쓰지 않는다(C++ MarketClient + JSI pull).
 */
import type {BookView, Level} from '../native/hogaCore';

type WireLevel = [number, number];
type MarketMessage =
  | {t: 'snap'; sym: string; seq: number; bids: WireLevel[]; asks: WireLevel[]}
  | {t: 'delta'; sym: string; seq: number; side: 'B' | 'A'; px: number; qty: number}
  | {t: 'trade'; sym: string; ts: number; px: number; qty: number; aggr: 'B' | 'A'};

export type ApplyResult = 'applied' | 'gap' | 'ignored' | 'trade';

export class JsBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private seq = 0;
  private live = false;
  private updatedAt = 0;
  messages = 0;
  gaps = 0;

  constructor(readonly symbol: string, private readonly now: () => number = Date.now) {}

  /** 원문 한 줄을 반영한다. 형식이 틀리거나 다른 종목이면 ignored */
  applyRaw(text: string): ApplyResult {
    let msg: MarketMessage;
    try {
      msg = JSON.parse(text) as MarketMessage;
    } catch {
      return 'ignored';
    }
    return this.apply(msg);
  }

  apply(msg: MarketMessage): ApplyResult {
    if (!msg || msg.sym !== this.symbol) return 'ignored';
    this.messages += 1;
    if (msg.t === 'trade') return 'trade';
    if (msg.t === 'snap') {
      this.bids = new Map(msg.bids);
      this.asks = new Map(msg.asks);
      this.seq = msg.seq;
      this.live = true;
      this.updatedAt = this.now();
      return 'applied';
    }
    if (msg.t !== 'delta') return 'ignored';
    if (!this.live || msg.seq <= this.seq) return 'ignored';
    if (msg.seq !== this.seq + 1) {
      // 누락: 다음 스냅샷(재접속·재동기화)이 올 때까지 멈춘다
      this.live = false;
      this.gaps += 1;
      return 'gap';
    }
    const side = msg.side === 'B' ? this.bids : this.asks;
    if (msg.qty > 0) side.set(msg.px, msg.qty);
    else side.delete(msg.px);
    this.seq = msg.seq;
    this.updatedAt = this.now();
    return 'applied';
  }

  view(depth: number): BookView {
    const top = (side: Map<number, number>, desc: boolean): Level[] =>
      [...side.entries()].sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).slice(0, depth);
    return {
      subscribed: true,
      seq: this.seq,
      sync: this.live ? 'live' : 'resyncing',
      bids: top(this.bids, true),
      asks: top(this.asks, false),
      lastUpdateMs: this.updatedAt,
    };
  }
}
