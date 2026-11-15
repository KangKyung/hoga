import type { Bus } from '../bus.js';
import {
  MatchingEngine,
  priceLimits,
  roundToTick,
  tickSize,
  type ExecutionResult,
  type OrderRequest,
} from '../core.js';
import type { Metrics } from '../metrics.js';
import { toWireSide, type DeltaMessage, type SnapshotMessage, type TradeMessage } from '../protocol.js';
import { SYMBOLS, type SymbolInfo } from './symbols.js';

export interface MarketOptions {
  /** 0~1. 이 확률로 변경분 발행을 건너뛴다(seq는 증가) */
  dropSeqRate?: number;
  random?: () => number;
  now?: () => number;
  symbols?: readonly SymbolInfo[];
}

interface SymbolState {
  info: SymbolInfo;
  engine: InstanceType<typeof MatchingEngine>;
  seq: number;
  botOrders: number[];
}

const MAX_BOT_ORDERS = 300;

export type ExecutionListener = (symbol: string, result: ExecutionResult) => void;

/**
 * 시세의 단일 작성자(single writer).
 *
 * 종목별 seq는 이 클래스만 발급한다. 주문 체결로 바뀐 가격대(LevelChange)마다 seq를 하나씩
 * 붙여 버스로 내보낸다. Node 이벤트 루프 한 스레드에서만 실행되므로 순서가 꼬이지 않는다.
 * 종목이 많아지면 종목 코드 기준으로 이 프로세스를 나눈다(샤딩).
 */
export class Market {
  private readonly states = new Map<string, SymbolState>();
  private readonly listeners = new Set<ExecutionListener>();
  private readonly dropSeqRate: number;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    private readonly bus: Bus,
    private readonly metrics: Metrics,
    options: MarketOptions = {},
  ) {
    this.dropSeqRate = options.dropSeqRate ?? 0;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    for (const info of options.symbols ?? SYMBOLS) {
      this.states.set(info.code, {
        info,
        engine: new MatchingEngine({ basePrice: info.basePrice }),
        seq: 0,
        botOrders: [],
      });
    }
    metrics.describe('hoga_market_deltas_total', 'counter', 'Book deltas published');
    metrics.describe('hoga_market_deltas_dropped_total', 'counter', 'Book deltas skipped by fault injection');
    metrics.describe('hoga_market_trades_total', 'counter', 'Trades executed');
  }

  /** 체결·취소가 일어날 때마다 호출(주문 추적용) */
  onExecution(listener: ExecutionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  has(symbol: string): boolean {
    return this.states.has(symbol);
  }

  list() {
    return [...this.states.values()].map(({ info, engine }) => ({
      ...info,
      lastPrice: engine.lastPrice ?? info.basePrice,
      tickSize: tickSize(engine.lastPrice ?? info.basePrice),
      limits: priceLimits(info.basePrice),
    }));
  }

  snapshot(symbol: string, depth = 20): SnapshotMessage {
    const state = this.require(symbol);
    return {
      t: 'snap',
      sym: symbol,
      seq: state.seq,
      ts: this.now(),
      bids: state.engine.depth('bid', depth).map((l) => [l.price, l.qty]),
      asks: state.engine.depth('ask', depth).map((l) => [l.price, l.qty]),
    };
  }

  submit(symbol: string, order: OrderRequest): ExecutionResult {
    const state = this.require(symbol);
    const result = state.engine.submit(order);
    this.publish(state, result, order.side);
    for (const listener of this.listeners) listener(symbol, result);
    return result;
  }

  cancel(symbol: string, orderId: number): ExecutionResult {
    const state = this.require(symbol);
    const result = state.engine.cancel(orderId);
    this.publish(state, result, null);
    for (const listener of this.listeners) listener(symbol, result);
    return result;
  }

  /** 모의 주문 발생기. 종목마다 intervalMs 주기로 호가를 만들고 가끔 체결시킨다. */
  startSimulator(intervalMs: number): () => void {
    if (intervalMs <= 0) return () => {};
    const timer = setInterval(() => {
      for (const state of this.states.values()) this.simulateOnce(state);
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** 테스트·워밍업용: 각 종목에 n번 모의 주문 */
  warmUp(rounds: number): void {
    for (let i = 0; i < rounds; i++) {
      for (const state of this.states.values()) this.simulateOnce(state);
    }
  }

  private require(symbol: string): SymbolState {
    const state = this.states.get(symbol);
    if (!state) throw new Error(`unknown symbol ${symbol}`);
    return state;
  }

  private publish(state: SymbolState, result: ExecutionResult, takerSide: 'bid' | 'ask' | null): void {
    const sym = state.info.code;
    for (const change of result.changes) {
      state.seq += 1;
      if (this.dropSeqRate > 0 && this.random() < this.dropSeqRate) {
        this.metrics.inc('hoga_market_deltas_dropped_total', { sym });
        continue;
      }
      const msg: DeltaMessage = {
        t: 'delta',
        sym,
        seq: state.seq,
        ts: this.now(),
        side: toWireSide(change.side),
        px: change.price,
        qty: change.qty,
      };
      this.bus.publish(sym, 'book', JSON.stringify(msg));
      this.metrics.inc('hoga_market_deltas_total', { sym });
    }
    if (takerSide) {
      for (const fill of result.fills) {
        const msg: TradeMessage = {
          t: 'trade',
          sym,
          ts: this.now(),
          px: fill.price,
          qty: fill.qty,
          aggr: toWireSide(takerSide),
        };
        this.bus.publish(sym, 'trade', JSON.stringify(msg));
        this.metrics.inc('hoga_market_trades_total', { sym });
      }
    }
  }

  private simulateOnce(state: SymbolState): void {
    const { engine, info } = state;
    const ref = engine.lastPrice ?? info.basePrice;
    const band = priceLimits(info.basePrice);
    const clamp = (p: number) => Math.min(band.upper, Math.max(band.lower, p));
    const r = this.random();

    if (r < 0.05 && state.botOrders.length > 0) {
      const idx = Math.floor(this.random() * state.botOrders.length);
      const [id] = state.botOrders.splice(idx, 1);
      if (id !== undefined) this.cancel(info.code, id);
      return;
    }

    const side = this.random() < 0.5 ? 'bid' : 'ask';
    const qty = (1 + Math.floor(this.random() * 50)) * 10;
    let price: number;

    if (r < 0.3) {
      // 반대편 최우선 호가를 때려 체결을 만든다
      const opposite = engine.depth(side === 'bid' ? 'ask' : 'bid', 1)[0];
      if (!opposite) return;
      price = opposite.price;
    } else {
      // 기준가 주변 1~5틱에 대기 호가
      const ticks = 1 + Math.floor(this.random() * 5);
      const tick = tickSize(ref);
      price =
        side === 'bid'
          ? roundToTick(clamp(ref - ticks * tick), 'down')
          : roundToTick(clamp(ref + ticks * tick), 'up');
      price = clamp(price);
    }

    const result = this.submit(info.code, { side, type: 'limit', price, qty });
    if (result.resting > 0) state.botOrders.push(result.id);

    while (state.botOrders.length > MAX_BOT_ORDERS) {
      const oldest = state.botOrders.shift();
      if (oldest !== undefined) this.cancel(info.code, oldest);
    }
  }
}
