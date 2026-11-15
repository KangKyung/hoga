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
  | 'UNKNOWN_ORDER';

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

/** 한 종목의 가격·시간 우선 매칭 엔진(C++). 한 스레드(이벤트 루프)에서만 사용. */
export class MatchingEngine {
  constructor(options: { basePrice: number; maxQty?: number });
  submit(order: OrderRequest): ExecutionResult;
  cancel(id: number): ExecutionResult;
  depth(side: Side, levels?: number): Level[];
  readonly lastPrice: number | null;
  readonly restingOrderCount: number;
}
