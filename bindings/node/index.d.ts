export type Side = 'bid' | 'ask';
export type OrderType = 'limit' | 'market';
export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
export type RejectReason =
  | 'NONE'
  | 'INVALID_QTY'
  | 'QTY_TOO_LARGE'
  | 'INVALID_PRICE'
  | 'OFF_TICK'
  | 'OUT_OF_PRICE_LIMIT'
  | 'NO_LIQUIDITY'
  | 'UNKNOWN_ORDER'
  | 'EXCEEDS_OPEN_QTY'
  | 'MARKET_CLOSED'
  | 'MARKET_IN_AUCTION'
  | 'INSUFFICIENT_CASH'
  | 'INSUFFICIENT_QTY';

export type TradingMode = 'CONTINUOUS' | 'AUCTION' | 'HALTED';
export type MarketPhase = 'PRE_OPEN' | 'OPEN' | 'CLOSING' | 'CLOSED';
export type ViKind = 'NONE' | 'STATIC' | 'DYNAMIC';

export interface AccountLimits {
  /** 주문가능금액(원) */
  availableCash: number;
  /** 매도가능수량 */
  sellableQty: number;
}

/** 단일가 예상 체결. qty 0 = 체결 없음 */
export interface Indicative {
  price: number;
  qty: number;
}

export interface Level {
  price: number;
  qty: number;
}

export interface OrderRequest {
  side: Side;
  /** 기본값 'limit' */
  type?: OrderType;
  /** 원 단위 정수. 시장가는 생략 또는 0 */
  price?: number;
  qty: number;
}

export interface Fill {
  taker: number;
  maker: number;
  takerSide: Side;
  price: number;
  qty: number;
}

/** 한 가격대의 잔량 변화. qty 0 = 가격대 소멸. 시세 변경분으로 그대로 내보낸다. */
export interface LevelChange {
  side: Side;
  price: number;
  qty: number;
}

export interface ExecutionResult {
  /** 거부되면 0 */
  id: number;
  status: OrderStatus;
  reject: RejectReason;
  filled: number;
  resting: number;
  fills: Fill[];
  changes: LevelChange[];
}

export interface ValidationPolicy {
  basePrice?: number;
  maxQty?: number;
}

/** hoga-core 버전 문자열 */
export function coreVersion(): string;
/** 국내 주식 호가가격단위(원). 0 이하 가격은 0. 정수가 아니면 TypeError. */
export function tickSize(price: number): number;
export function roundToTick(price: number, mode: 'up' | 'down'): number;
export function priceLimits(basePrice: number): { lower: number; upper: number };
export function validateOrder(order: OrderRequest, policy?: ValidationPolicy): RejectReason;

/** 주문가능금액·매도가능수량 확인(앱과 같은 C++ 규칙). 시장가 매수는 상한가로 계산 */
export function checkAccount(order: OrderRequest, limits: AccountLimits, upperLimit: number): RejectReason;
/** 지금 한도로 낼 수 있는 최대 수량 */
export function maxOrderQty(
  order: { side: Side; type?: OrderType; price?: number },
  limits: AccountLimits,
  upperLimit: number,
  maxQty?: number,
): number;
/** VI 판정(정적 우선). bps 기본: 정적 1000(10%), 동적 300(3%) */
export function checkVi(
  staticRef: number,
  dynamicRef: number,
  price: number,
  policy?: { staticBps?: number; dynamicBps?: number },
): ViKind;
/** 서울 시각(0~1439분) → 정규장 구간 */
export function phaseAt(minuteOfDayKst: number): MarketPhase;

/** 한 종목의 가격·시간 우선 매칭 엔진(C++). 한 스레드(이벤트 루프)에서만 사용. */
export class MatchingEngine {
  constructor(options: { basePrice: number; maxQty?: number });
  submit(order: OrderRequest): ExecutionResult;
  cancel(id: number): ExecutionResult;
  depth(side: Side, levels?: number): Level[];
  /** 미체결 잔량을 qty만큼 줄인다(시간 우선순위 유지). 전량이면 취소 */
  reduce(id: number, qty: number): ExecutionResult;
  /** 단일가 예상 체결가·수량 */
  indicative(reference: number): Indicative;
  /** 단일가 체결(모두 한 가격) */
  uncross(reference: number): ExecutionResult;
  mode: TradingMode;
  readonly lastPrice: number | null;
  readonly restingOrderCount: number;
}

/** [start(epoch ms), open, high, low, close, volume] */
export type CandleRow = [number, number, number, number, number, number];

/** 체결 → 봉 집계(C++). 앱의 실시간 봉과 같은 코드 */
export class CandleSeries {
  constructor(options?: { intervalMs?: number; maxBars?: number });
  addTrade(ts: number, price: number, qty: number): void;
  /** 최근 limit개, 오래된 것부터. bucketMs가 기본 구간의 배수면 묶어서 돌려준다 */
  bars(limit?: number, bucketMs?: number): CandleRow[];
  readonly version: number;
}
