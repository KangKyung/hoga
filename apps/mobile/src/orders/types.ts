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
  /** 정정 주문: 원주문 키(원주문 미체결 잔량에서 qty만큼 옮긴다) */
  amendOf?: string;
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
  /** 원주문 쪽: 정정으로 옮겨 간 수량 */
  amended?: number;
}

/** 서버로 보냈지만 결과를 아직 확정하지 못한 주문(먼저 기록하고 보낸다) */
export interface PendingOrder {
  key: string;
  draft: OrderDraft;
  createdAt: number;
  /** 주문한 사용자. 같은 기기에서 다른 사용자가 로그인해도 남의 주문을 조회(404 → "전송 안 됨")하지 않게 */
  userId?: string;
}
