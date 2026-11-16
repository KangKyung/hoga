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
  /** 정정 주문이면 원주문 키 */
  amendOf?: string;
  /** 이 주문에서 정정으로 옮겨 간 수량(원주문 쪽) */
  amended?: number;
}

export type RecordListener = (record: OrderRecord) => void;

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
  private readonly listeners = new Set<RecordListener>();

  constructor(
    market: Market,
    private readonly bus: Bus,
    private readonly now: () => number = Date.now,
  ) {
    this.unsubscribe = market.onExecution((symbol, result) => this.onExecution(symbol, result));
  }

  /** 기록이 바뀔 때마다(접수·체결·취소·정정). 계좌 원장이 쓴다 */
  onChange(listener: RecordListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  /** 정정으로 원주문 잔량이 qty만큼 빠졌다. 잔량이 0이 되면 원주문은 끝(취소와 같은 상태) */
  markAmended(record: OrderRecord, qty: number): void {
    record.resting -= qty;
    record.amended = (record.amended ?? 0) + qty;
    if (record.resting === 0) {
      this.byOrder.delete(`${record.symbol}:${record.orderId}`);
      record.status = record.filled > 0 ? 'PARTIALLY_FILLED' : 'CANCELLED';
    }
    record.updatedAt = this.now();
    this.emit(record);
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
      // 접속매매: 걸려 있던 쪽(maker)만 내 기록일 수 있다(새 주문의 기록은 submit 뒤에 추가된다).
      // 단일가 체결: 양쪽 모두 걸려 있던 주문이다.
      for (const id of [fill.maker, fill.taker]) {
        const record = this.byOrder.get(`${symbol}:${id}`);
        if (!record) continue;
        record.filled += fill.qty;
        record.resting -= fill.qty;
        record.fills.push({ price: fill.price, qty: fill.qty });
        record.status = record.resting === 0 ? 'FILLED' : 'PARTIALLY_FILLED';
        record.updatedAt = this.now();
        if (record.resting === 0) this.byOrder.delete(`${symbol}:${id}`);
        this.emit(record, { price: fill.price, qty: fill.qty });
      }
    }
  }

  private emit(record: OrderRecord, fill?: { price: number; qty: number }): void {
    for (const listener of this.listeners) listener(record);
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
      ...(record.amendOf ? { amendOf: record.amendOf } : {}),
      ...(record.amended ? { amended: record.amended } : {}),
      ...(fill ? { fill } : {}),
      ts: this.now(),
    };
    this.bus.publishUser(record.userId, JSON.stringify(msg));
  }
}
