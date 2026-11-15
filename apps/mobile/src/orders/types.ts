export type Side = 'bid' | 'ask';
export type OrderType = 'limit' | 'market';
export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export interface OrderDraft {
  symbol: string;
  side: Side;
  type: OrderType;
  /** 원. 시장가는 0 */
  price: number;
  qty: number;
}

/** 서버 주문 기록(server/src/orders/tracker.ts와 같은 모양) */
export interface OrderRecord extends OrderDraft {
  key: string;
  orderId: number;
  status: OrderStatus;
  reject: string;
  filled: number;
  resting: number;
  fills: {price: number; qty: number}[];
  acceptedAt: number;
  updatedAt: number;
}

/** 서버로 보냈지만 결과를 아직 확정하지 못한 주문(먼저 기록하고 보낸다) */
export interface PendingOrder {
  key: string;
  draft: OrderDraft;
  createdAt: number;
}
