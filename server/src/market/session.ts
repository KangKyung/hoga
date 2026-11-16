import type { Bus } from '../bus.js';
import { checkVi, phaseAt, type ExecutionResult, type MarketPhase, type TradingMode } from '../core.js';
import type { StatusMessage } from '../protocol.js';
import type { Market } from './market.js';

export interface SessionOptions {
  /** manual: 관리 콘솔로 구간을 바꾼다(기본 장중). krx: 서울 시각 정규장 일정(평일 08:30~15:30) */
  clock: 'manual' | 'krx';
  viDurationMs: number;
  viStaticBps: number;
  viDynamicBps: number;
  now?: () => number;
}

interface ViState {
  kind: 'STATIC' | 'DYNAMIC';
  until: number;
  ref: number;
  timer: NodeJS.Timeout;
}

const EXP_THROTTLE_MS = 200;

/**
 * 장 운영 구간과 VI(변동성완화장치).
 *
 * 매칭 엔진(C++)의 매매 방식을 바꾸는 것만 여기서 하고, 단일가 체결·VI 판정 규칙은 C++에 있다.
 *   PRE_OPEN·CLOSING → 전 종목 단일가(AUCTION)
 *   OPEN             → 접속매매(CONTINUOUS), VI 발동 종목만 단일가
 *   CLOSED           → 거래 안 됨(HALTED)
 * 단일가에서 다른 방식으로 넘어갈 때는 먼저 모인 주문을 한 가격에 체결(uncross)한다.
 *
 * VI는 체결이 일어난 뒤 판정한다(실제 거래소는 주문 처리 도중 멈춘다 — 단순화).
 */
export class MarketSession {
  private current: MarketPhase = 'OPEN';
  private readonly vi = new Map<string, ViState>();
  /** 정적 VI 기준가: 장 시작 단일가 체결가(없으면 기준가). VI 단일가 뒤에는 그 체결가 */
  private readonly staticRef = new Map<string, number>();
  /** 동적 VI 기준: 직전 체결가 */
  private readonly lastPx = new Map<string, number>();
  private readonly lastSent = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | undefined;
  private clockTimer: NodeJS.Timeout | undefined;
  private uncrossing = false;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly market: Market,
    private readonly bus: Bus,
    private readonly options: SessionOptions,
  ) {
    this.now = options.now ?? Date.now;
    for (const code of market.codes()) {
      const px = market.lastPrice(code);
      this.staticRef.set(code, px);
      this.lastPx.set(code, px);
    }
    this.unsubscribe = market.onExecution((symbol, result) => this.onExecution(symbol, result));
  }

  get phase(): MarketPhase {
    return this.current;
  }

  get clock(): 'manual' | 'krx' {
    return this.options.clock;
  }

  /** krx 모드면 1초마다 서울 시각을 보고 구간을 맞춘다 */
  start(): void {
    if (this.options.clock === 'krx') {
      this.setPhase(krxPhase(this.now()));
      this.clockTimer = setInterval(() => {
        const next = krxPhase(this.now());
        if (next !== this.current) this.setPhase(next);
      }, 1_000);
      this.clockTimer.unref();
    }
  }

  stop(): void {
    clearInterval(this.clockTimer);
    clearTimeout(this.flushTimer);
    for (const v of this.vi.values()) clearTimeout(v.timer);
    this.vi.clear();
    this.unsubscribe();
  }

  setPhase(next: MarketPhase): void {
    if (next === this.current) return;
    const before = new Map(this.market.codes().map((c) => [c, this.market.mode(c)] as const));
    this.current = next;
    // 동시호가·장 종료로 넘어가면 VI는 의미가 없다
    if (next !== 'OPEN') {
      for (const v of this.vi.values()) clearTimeout(v.timer);
      this.vi.clear();
    }
    for (const code of this.market.codes()) this.apply(code, before.get(code)!);
    if (next === 'OPEN') {
      // 장 시작 단일가 체결가가 정적 VI 기준가
      for (const code of this.market.codes()) this.staticRef.set(code, this.market.lastPrice(code));
    }
  }

  /** 관리 콘솔·자동 판정 공용. 이미 VI면 해제 시각만 늦춘다 */
  triggerVi(symbol: string, kind: 'STATIC' | 'DYNAMIC', ref = this.market.lastPrice(symbol)): void {
    if (this.current !== 'OPEN') return;
    const existing = this.vi.get(symbol);
    if (existing) clearTimeout(existing.timer);
    const until = this.now() + this.options.viDurationMs;
    const timer = setTimeout(() => this.releaseVi(symbol), this.options.viDurationMs);
    timer.unref();
    const before = this.market.mode(symbol);
    this.vi.set(symbol, { kind, until, ref, timer });
    this.apply(symbol, before);
  }

  releaseVi(symbol: string): void {
    const v = this.vi.get(symbol);
    if (!v) return;
    clearTimeout(v.timer);
    this.vi.delete(symbol);
    this.apply(symbol, this.market.mode(symbol));
    // VI 단일가 체결가가 새 정적 기준가
    this.staticRef.set(symbol, this.market.lastPrice(symbol));
  }

  activeVi(): Array<{ symbol: string; kind: string; until: number }> {
    return [...this.vi.entries()].map(([symbol, v]) => ({ symbol, kind: v.kind, until: v.until }));
  }

  status(symbol: string): StatusMessage {
    const mode = this.market.mode(symbol);
    const v = this.vi.get(symbol);
    const exp = mode === 'AUCTION' ? this.market.indicative(symbol) : undefined;
    return {
      t: 'status',
      sym: symbol,
      phase: this.current,
      mode,
      vi: v ? { kind: v.kind, until: v.until, ref: v.ref } : null,
      exp: exp && exp.qty > 0 ? { px: exp.price, qty: exp.qty } : null,
      ts: this.now(),
    };
  }

  /** 한 종목의 매매 방식을 지금 구간·VI에 맞춘다 */
  private apply(symbol: string, before: TradingMode): void {
    const target = this.targetMode(symbol);
    if (before === 'AUCTION' && target !== 'AUCTION') {
      this.uncrossing = true;
      try {
        this.market.uncross(symbol);
      } finally {
        this.uncrossing = false;
      }
      this.lastPx.set(symbol, this.market.lastPrice(symbol));
    }
    this.market.setMode(symbol, target);
    this.publish(symbol);
  }

  private targetMode(symbol: string): TradingMode {
    switch (this.current) {
      case 'PRE_OPEN':
      case 'CLOSING':
        return 'AUCTION';
      case 'CLOSED':
        return 'HALTED';
      case 'OPEN':
        return this.vi.has(symbol) ? 'AUCTION' : 'CONTINUOUS';
    }
  }

  private onExecution(symbol: string, result: ExecutionResult): void {
    if (this.market.mode(symbol) === 'AUCTION') {
      // 단일가: 주문이 들어오거나 빠질 때마다 예상 체결가가 바뀐다 → 모아서 보낸다
      this.markDirty(symbol);
      return;
    }
    if (this.uncrossing || result.fills.length === 0) return;
    const prev = this.lastPx.get(symbol) ?? this.market.lastPrice(symbol);
    const staticRef = this.staticRef.get(symbol) ?? prev;
    for (const fill of result.fills) {
      const kind = checkVi(staticRef, prev, fill.price, {
        staticBps: this.options.viStaticBps,
        dynamicBps: this.options.viDynamicBps,
      });
      if (kind !== 'NONE') {
        this.lastPx.set(symbol, fill.price);
        this.triggerVi(symbol, kind, kind === 'STATIC' ? staticRef : prev);
        return;
      }
    }
    this.lastPx.set(symbol, result.fills.at(-1)!.price);
  }

  private markDirty(symbol: string): void {
    this.dirty.add(symbol);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      for (const s of this.dirty) this.publish(s);
      this.dirty.clear();
    }, EXP_THROTTLE_MS);
    this.flushTimer.unref();
  }

  private publish(symbol: string): void {
    const msg = this.status(symbol);
    // ts를 빼고 같으면 보내지 않는다
    const key = JSON.stringify({ ...msg, ts: 0 });
    if (this.lastSent.get(symbol) === key) return;
    this.lastSent.set(symbol, key);
    this.bus.publish(symbol, 'status', JSON.stringify(msg));
  }
}

/** 서울 시각 기준 정규장 구간(주말은 장 종료). 공휴일은 다루지 않는다 */
export function krxPhase(epochMs: number): MarketPhase {
  const kst = new Date(epochMs + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return 'CLOSED';
  return phaseAt(kst.getUTCHours() * 60 + kst.getUTCMinutes());
}
