import type { Bus } from '../bus.js';
import {
  CandleSeries,
  MatchingEngine,
  priceLimits,
  roundToTick,
  tickSize,
  type CandleRow,
  type ExecutionResult,
  type OrderRequest,
  type TradingMode,
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
  /** 시작 시 채워 넣을 과거 1분 봉 개수(모의 데이터). 0이면 없음 */
  historyMinutes?: number;
}

interface SymbolState {
  info: SymbolInfo;
  engine: InstanceType<typeof MatchingEngine>;
  seq: number;
  botOrders: number[];
  candles: InstanceType<typeof CandleSeries>;
  /** 모의 주문 발생기의 가격 폭 배수(관리 콘솔에서 조절). 1 = 기본 */
  volatility: number;
}

export interface DayStats {
  open: number;
  high: number;
  low: number;
  volume: number;
}

const MINUTE = 60_000;

const MAX_BOT_ORDERS = 300;

export type ExecutionListener = (symbol: string, result: ExecutionResult) => void;

/**
 * 시세의 단일 작성자(single writer).
 *
 * 종목별 seq는 이 클래스만 발급한다. 주문 체결로 바뀐 가격대(LevelChange)마다 seq를 하나씩
 * 붙여 버스로 내보낸다. Node 이벤트 루프 한 스레드에서만 실행되므로 순서가 꼬이지 않는다.
 * 종목이 많아지면 종목 코드 기준으로 이 프로세스를 나눈다(샤딩).
 */
/** 전체 호가(가격제한폭 안의 모든 가격) */
export const FULL_DEPTH = Number.MAX_SAFE_INTEGER;

export class Market {
  private readonly states = new Map<string, SymbolState>();
  private readonly listeners = new Set<ExecutionListener>();
  private dropSeqRate: number;
  private simIntervalMs = 0;
  /** 주기마다 종목별 모의 주문 횟수. 부하 실험에서 초당 틱 수를 올릴 때 쓴다(10ms × 10회 ≈ 종목당 초당 1,000회) */
  private simBurst = 1;
  private stopSim: () => void = () => {};
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
      const state: SymbolState = {
        info,
        engine: new MatchingEngine({ basePrice: info.basePrice }),
        seq: 0,
        botOrders: [],
        candles: new CandleSeries({ intervalMs: MINUTE, maxBars: 2_000 }),
        volatility: 1,
      };
      this.backfill(state, options.historyMinutes ?? 0);
      this.states.set(info.code, state);
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

  codes(): string[] {
    return [...this.states.keys()];
  }

  info(symbol: string): SymbolInfo {
    return this.require(symbol).info;
  }

  /** 최근 체결가(없으면 기준가) */
  lastPrice(symbol: string): number {
    const state = this.require(symbol);
    return state.engine.lastPrice ?? state.info.basePrice;
  }

  upperLimit(symbol: string): number {
    return priceLimits(this.require(symbol).info.basePrice).upper;
  }

  // ---- 매매 방식(장 운영 구간·VI) ----

  mode(symbol: string): TradingMode {
    return this.require(symbol).engine.mode;
  }

  setMode(symbol: string, mode: TradingMode): void {
    this.require(symbol).engine.mode = mode;
  }

  /** 단일가 예상 체결(기준: 최근 체결가) */
  indicative(symbol: string): { price: number; qty: number } {
    return this.require(symbol).engine.indicative(this.lastPrice(symbol));
  }

  /** 단일가 체결. 체결 알림·시세는 접속매매와 같은 경로로 나간다 */
  uncross(symbol: string): ExecutionResult {
    const state = this.require(symbol);
    const result = state.engine.uncross(this.lastPrice(symbol));
    this.publish(state, result, 'bid');
    for (const listener of this.listeners) listener(symbol, result);
    return result;
  }

  list() {
    return [...this.states.values()].map(({ info, engine }) => ({
      ...info,
      lastPrice: engine.lastPrice ?? info.basePrice,
      tickSize: tickSize(engine.lastPrice ?? info.basePrice),
      limits: priceLimits(info.basePrice),
    }));
  }

  /**
   * depth를 비우면 전체 호가. WebSocket 스냅샷은 반드시 전체여야 한다: 변경분(delta)은 깊이와 상관없이
   * 모든 가격에 대해 오므로, 일부만 준 스냅샷 위에 변경분을 쌓으면 위쪽이 빠질 때 아래에서 올라와야 할
   * 호가가 클라이언트에 영영 없다(seq는 이어져 재동기화도 일어나지 않는다).
   */
  snapshot(symbol: string, depth = FULL_DEPTH): SnapshotMessage {
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

  /** 오늘(서버 시각 자정 이후) 시가·고가·저가·거래량. 봉이 없으면 undefined */
  dayStats(symbol: string): DayStats | undefined {
    const bars = this.require(symbol).candles.bars(2_000, 0);
    const midnight = new Date(this.now());
    midnight.setHours(0, 0, 0, 0);
    const today = bars.filter(([start]) => start >= midnight.getTime());
    if (today.length === 0) return undefined;
    return {
      open: today[0]![1],
      high: Math.max(...today.map((b) => b[2])),
      low: Math.min(...today.map((b) => b[3])),
      volume: today.reduce((sum, b) => sum + b[5], 0),
    };
  }

  // ---- 관리 콘솔(장애·부하 시연)용 제어 ----

  get faults() {
    return { dropSeqRate: this.dropSeqRate, simIntervalMs: this.simIntervalMs, simBurst: this.simBurst };
  }

  setDropSeqRate(rate: number): void {
    this.dropSeqRate = Math.min(1, Math.max(0, rate));
  }

  volatility(symbol: string): number {
    return this.require(symbol).volatility;
  }

  /** symbol이 없으면 전 종목. 배수는 0.2~10 */
  setVolatility(multiplier: number, symbol?: string): void {
    const value = Math.min(10, Math.max(0.2, multiplier));
    for (const state of symbol ? [this.require(symbol)] : this.states.values()) state.volatility = value;
  }

  /** 1분 봉(오래된 것부터). bucketMs가 1분의 배수면 묶어서 */
  candles(symbol: string, limit: number, bucketMs = 0): CandleRow[] {
    return this.require(symbol).candles.bars(limit, bucketMs);
  }

  submit(symbol: string, order: OrderRequest): ExecutionResult {
    const state = this.require(symbol);
    const result = state.engine.submit(order);
    this.publish(state, result, order.side);
    for (const listener of this.listeners) listener(symbol, result);
    return result;
  }

  /** 미체결 잔량을 qty만큼 줄인다(정정). 남은 수량의 시간 우선순위는 그대로 */
  reduce(symbol: string, orderId: number, qty: number): ExecutionResult {
    const state = this.require(symbol);
    const result = state.engine.reduce(orderId, qty);
    this.publish(state, result, null);
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

  /**
   * 모의 주문 발생기. 종목마다 intervalMs 주기로 burst번 호가를 만들고 가끔 체결시킨다.
   * burst를 생략하면 지금 값을 유지한다.
   */
  startSimulator(intervalMs: number, burst?: number): () => void {
    this.stopSim();
    this.simIntervalMs = Math.max(0, intervalMs);
    if (burst !== undefined) this.simBurst = Math.min(50, Math.max(1, Math.floor(burst)));
    if (this.simIntervalMs <= 0) {
      this.stopSim = () => {};
      return () => {};
    }
    const timer = setInterval(() => {
      for (let i = 0; i < this.simBurst; i++) {
        for (const state of this.states.values()) {
          // 거래가 드문 종목은 가끔만
          if (state.info.activity !== undefined && this.random() >= state.info.activity) continue;
          this.simulateOnce(state);
        }
      }
    }, this.simIntervalMs);
    timer.unref();
    const stop = () => clearInterval(timer);
    this.stopSim = stop;
    return () => {
      // 다시 시작해 바뀐 타이머가 아니라면 멈춘다
      if (this.stopSim === stop) {
        stop();
        this.stopSim = () => {};
        this.simIntervalMs = 0;
      }
    };
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
    for (const fill of result.fills) state.candles.addTrade(this.now(), fill.price, fill.qty);
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

  /**
   * 차트가 처음부터 비어 있지 않도록 과거 체결을 모의로 만든다.
   * 기준가에서 거꾸로 무작위 보행해 지금 가격이 기준가 근처가 되게 하고, 호가단위·가격제한폭을 지킨다.
   */
  private backfill(state: SymbolState, minutes: number): void {
    if (minutes <= 0) return;
    const { basePrice } = state.info;
    const band = priceLimits(basePrice);
    const clamp = (p: number) =>
      roundToTick(Math.round(Math.min(band.upper, Math.max(band.lower, p))), 'down') || band.lower;
    const nowBucket = Math.floor(this.now() / MINUTE) * MINUTE;

    const closes: number[] = [];
    let price = basePrice;
    for (let i = 0; i < minutes; i++) {
      closes.push(price);
      const drift = (this.random() - 0.5) * 6 * tickSize(price);
      price = clamp(price - drift);
    }
    closes.reverse();
    for (let i = 0; i < minutes; i++) {
      const start = nowBucket - (minutes - i) * MINUTE;
      const open = i === 0 ? closes[0]! : closes[i - 1]!;
      const close = closes[i]!;
      const tick = tickSize(close);
      const high = clamp(Math.max(open, close) + Math.floor(this.random() * 3) * tick);
      const low = clamp(Math.min(open, close) - Math.floor(this.random() * 3) * tick);
      // 실시간 모의 체결과 비슷한 규모(분당 수만 주)가 되도록
      const volume = () => (5 + Math.floor(this.random() * 40)) * 250;
      for (const [offset, px] of [[1_000, open], [20_000, high], [40_000, low], [59_000, close]] as const) {
        state.candles.addTrade(start + offset, px, volume());
      }
    }
  }

  private simulateOnce(state: SymbolState): void {
    const { engine, info } = state;
    if (engine.mode === 'HALTED') return; // 장 종료: 새 호가 없음
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
      // 기준가 주변 1~5틱(× 변동성 배수)에 대기 호가
      const ticks = 1 + Math.floor(this.random() * 5 * state.volatility);
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
