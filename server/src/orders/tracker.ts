import type { Bus } from '../bus.js';
import type { ExecutionResult } from '../core.js';
import type { Market } from '../market/market.js';
import type { OrderEventMessage } from '../protocol.js';

export interface OrderRecord {
  key: string;
  userId: string;
  symbol: string;
  side: 'bid' | 'ask';
  type: 'limit' | 'market';
  price: number;
  qty: number;
  /** 거부되면 0 */
  orderId: number;
  status: ExecutionResult['status'];
  reject: ExecutionResult['reject'];
  filled: number;
  resting: number;
  fills: { price: number; qty: number }[];
  acceptedAt: number;
  updatedAt: number;
}

/**
 * 사용자 주문의 현재 상태를 관리한다.
 *
 * 내 지정가 주문이 호가창에 걸려 있다가 다른 사람(모의 주문 포함)의 주문으로 체결되면,
 * 매칭 엔진의 Fill.maker가 내 주문 번호가 된다. 그때 기록을 고치고 나에게만 알림을 보낸다.
 */
export class OrderTracker {
  private readonly byKey = new Map<string, OrderRecord>();
  /** `${symbol}:${orderId}` → 기록. 매칭 엔진의 주문 번호는 종목마다 따로 매겨진다 */
  private readonly byOrder = new Map<string, OrderRecord>();
  private readonly unsubscribe: () => void;

  constructor(
    market: Market,
    private readonly bus: Bus,
    private readonly now: () => number = Date.now,
  ) {
    this.unsubscribe = market.onExecution((symbol, result) => this.onExecution(symbol, result));
  }

  static userKey(userId: string, key: string): string {
    return `${userId}:${key}`;
  }

  add(record: OrderRecord): void {
    this.byKey.set(OrderTracker.userKey(record.userId, record.key), record);
    if (record.orderId > 0 && record.resting > 0) this.byOrder.set(`${record.symbol}:${record.orderId}`, record);
    this.emit(record);
  }

  get(userId: string, key: string): OrderRecord | undefined {
    return this.byKey.get(OrderTracker.userKey(userId, key));
  }

  list(userId: string, limit = 50): OrderRecord[] {
    return [...this.byKey.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.acceptedAt - a.acceptedAt)
      .slice(0, limit);
  }

  markCancelled(record: OrderRecord): void {
    this.byOrder.delete(`${record.symbol}:${record.orderId}`);
    record.status = 'CANCELLED';
    record.resting = 0;
    record.updatedAt = this.now();
    this.emit(record);
  }

  close(): void {
    this.unsubscribe();
  }

  private onExecution(symbol: string, result: ExecutionResult): void {
    for (const fill of result.fills) {
      const record = this.byOrder.get(`${symbol}:${fill.maker}`);
      if (!record) continue;
      record.filled += fill.qty;
      record.resting -= fill.qty;
      record.fills.push({ price: fill.price, qty: fill.qty });
      record.status = record.resting === 0 ? 'FILLED' : 'PARTIALLY_FILLED';
      record.updatedAt = this.now();
      if (record.resting === 0) this.byOrder.delete(`${symbol}:${fill.maker}`);
      this.emit(record, { price: fill.price, qty: fill.qty });
    }
  }

  private emit(record: OrderRecord, fill?: { price: number; qty: number }): void {
    const msg: OrderEventMessage = {
      t: 'order',
      key: record.key,
      orderId: record.orderId,
      symbol: record.symbol,
      side: record.side,
      type: record.type,
      price: record.price,
      qty: record.qty,
      status: record.status,
      filled: record.filled,
      resting: record.resting,
      ...(fill ? { fill } : {}),
      ts: this.now(),
    };
    this.bus.publishUser(record.userId, JSON.stringify(msg));
  }
}
