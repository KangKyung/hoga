import { z } from 'zod';

/**
 * WebSocket 시세 프로토콜.
 *
 * - 종목별 seq는 호가 변경분(delta)마다 1씩 증가한다. 스냅샷은 "seq까지 반영된 상태"다.
 * - 클라이언트는 seq == last + 1 일 때만 반영하고, 건너뛰면 GET /book/:symbol로 다시 맞춘다.
 * - delta의 qty는 변화량이 아니라 그 가격대의 "새 잔량"(0 = 삭제)이라 중복 적용해도 안전하다.
 * - 체결(trade)은 정보용으로 seq 없이 보낸다.
 * - 가격·수량은 모두 정수(원, 주).
 */

export const SYMBOL_PATTERN = /^[0-9]{6}$/;
const symbol = z.string().regex(SYMBOL_PATTERN, 'symbol must be 6 digits');

// ---------- 클라이언트 → 서버 ----------

export const clientMessage = z.discriminatedUnion('op', [
  z.object({ op: z.literal('sub'), symbols: z.array(symbol).min(1).max(50) }),
  z.object({ op: z.literal('unsub'), symbols: z.array(symbol).min(1).max(50) }),
  z.object({ op: z.literal('ping'), ts: z.number().optional() }),
  /** 로그인한 사용자의 주문 알림을 받으려면 액세스 토큰으로 인증 */
  z.object({ op: z.literal('auth'), token: z.string().min(10).max(4096) }),
  /** 로그아웃: 연결은 유지하고(시세 구독 그대로) 사용자 알림만 끊는다 */
  z.object({ op: z.literal('unauth') }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

// ---------- 서버 → 클라이언트 ----------

/** [가격, 잔량] */
export type WireLevel = [number, number];
export type WireSide = 'B' | 'A';

export interface SnapshotMessage {
  t: 'snap';
  sym: string;
  seq: number;
  ts: number;
  bids: WireLevel[];
  asks: WireLevel[];
}

export interface DeltaMessage {
  t: 'delta';
  sym: string;
  seq: number;
  ts: number;
  side: WireSide;
  px: number;
  qty: number;
}

export interface TradeMessage {
  t: 'trade';
  sym: string;
  ts: number;
  px: number;
  qty: number;
  /** 체결을 일으킨 쪽. N = 단일가 체결(모인 주문을 한 가격에 맞춰 주도한 쪽이 없다) */
  aggr: WireSide | 'N';
}

export interface ErrorMessage {
  t: 'error';
  code: 'BAD_MESSAGE' | 'UNKNOWN_SYMBOL' | 'TOO_MANY_SUBSCRIPTIONS' | 'RATE_LIMITED' | 'UNAUTHORIZED';
  message: string;
}

export interface PongMessage {
  t: 'pong';
  ts: number;
}

export interface SubscribedMessage {
  t: 'subscribed';
  symbols: string[];
}

export interface AuthedMessage {
  t: 'authed';
  userId: string;
}

export interface UnauthedMessage {
  t: 'unauthed';
}

/** 내 주문 상태가 바뀔 때(접수·체결·취소) 나에게만 오는 메시지 */
export interface OrderEventMessage {
  t: 'order';
  key: string;
  orderId: number;
  symbol: string;
  side: 'bid' | 'ask';
  type: 'limit' | 'market';
  price: number;
  qty: number;
  status: string;
  filled: number;
  resting: number;
  amendOf?: string;
  amended?: number;
  /** 이번 변화가 체결이면 그 체결 */
  fill?: { price: number; qty: number };
  ts: number;
}

/**
 * 종목의 매매 상태. 바뀔 때만(예상 체결가는 최대 초당 5번) 보내고, 구독 직후 스냅샷 다음에 한 번 보낸다.
 * 빈도가 낮아 이진 연결에도 JSON 텍스트로 보낸다.
 */
export interface StatusMessage {
  t: 'status';
  sym: string;
  /** 장 운영 구간(시장 전체) */
  phase: 'PRE_OPEN' | 'OPEN' | 'CLOSING' | 'CLOSED';
  /** 이 종목의 매매 방식: 접속매매 / 단일가(동시호가·VI) / 거래 안 됨 */
  mode: 'CONTINUOUS' | 'AUCTION' | 'HALTED';
  /** VI 발동 중이면 종류·해제 예정 시각(epoch ms)·발동 기준가 */
  vi: { kind: 'STATIC' | 'DYNAMIC'; until: number; ref: number } | null;
  /** 단일가 예상 체결가·수량(단일가가 아니거나 체결이 없으면 null) */
  exp: { px: number; qty: number } | null;
  ts: number;
}

export type ServerMessage =
  | AuthedMessage
  | UnauthedMessage
  | OrderEventMessage
  | SnapshotMessage
  | DeltaMessage
  | TradeMessage
  | ErrorMessage
  | PongMessage
  | StatusMessage
  | SubscribedMessage;

export const toWireSide = (side: 'bid' | 'ask'): WireSide => (side === 'bid' ? 'B' : 'A');

// ---------- REST ----------

export const orderBody = z
  .object({
    symbol,
    side: z.enum(['bid', 'ask']),
    type: z.enum(['limit', 'market']).default('limit'),
    price: z.number().int().nonnegative().optional(),
    qty: z.number().int().positive(),
    /** 정정 주문: 원주문의 멱등 키. 원주문 미체결 잔량에서 qty만큼 빼서 새 가격으로 낸다 */
    amendOf: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .strict();
export type OrderBody = z.infer<typeof orderBody>;

/** Idempotency-Key: 클라이언트가 주문마다 만드는 UUID 등. 재전송은 같은 키로. */
export const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
