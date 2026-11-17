import { checkAccount, maxOrderQty, type AccountLimits, type RejectReason } from '../core.js';
import type { Market } from '../market/market.js';
import type { OrderRecord } from '../orders/tracker.js';

/**
 * 모의 계좌 원장: 예수금·보유 종목·미체결 주문이 묶어 둔 금액/수량.
 *
 * 규칙(단순화, 수수료·세금 없음)
 * - 매수 주문은 "미체결 잔량 × 단가"를 묶어 둔다. 지정가는 주문가, 시장가는 상한가(C++ reservePrice).
 * - 매도 주문은 미체결 잔량만큼 매도가능수량에서 뺀다.
 * - 현금·보유 수량은 체결로만 바뀐다. 취소·정정·시장가 잔량 소멸은 묶음이 줄어들 뿐이다.
 * → 주문 기록이 바뀔 때마다 "묶음 = 잔량"으로 다시 맞추면 되므로 경우의 수를 따로 다루지 않는다.
 *
 * 매칭 엔진과 같은 이벤트 루프(단일 작성자)에서만 바뀌므로, 확인 → 접수 사이에 다른 주문이 끼어들지 않는다.
 */
export interface Position {
  qty: number;
  /** 평균 매입가(원, 소수점 유지) */
  avgPrice: number;
}

interface Reservation {
  symbol: string;
  side: 'bid' | 'ask';
  /** 1주당 묶는 금액(매수만) */
  unit: number;
  qty: number;
}

interface Account {
  userId: string;
  accountNo: string;
  cash: number;
  realizedPnl: number;
  positions: Map<string, Position>;
  reservations: Map<string, Reservation>;
  /** 주문별로 이미 반영한 체결 수(record.fills 길이) */
  appliedFills: Map<string, number>;
}

export interface AccountSeed {
  accountNo: string;
  cash: number;
  positions?: Record<string, Position>;
}

/** 개발용 초기 계좌(모의) */
export const SEED_ACCOUNTS: Record<string, AccountSeed> = {
  'u-demo': {
    accountNo: '5001-10-000001',
    cash: 50_000_000,
    positions: {
      '000001': { qty: 100, avgPrice: 69_800 },
      '000002': { qty: 300, avgPrice: 19_100 },
      '000003': { qty: 1_000, avgPrice: 4_120 },
    },
  },
  'u-trader2': {
    accountNo: '5001-10-000002',
    cash: 20_000_000,
    positions: { '000002': { qty: 500, avgPrice: 18_200 }, '000004': { qty: 50, avgPrice: 150_000 } },
  },
};

export interface AccountSummary {
  accountNo: string;
  /** 예수금 */
  cash: number;
  /** 미체결 매수가 묶어 둔 금액 */
  reservedCash: number;
  /** 주문가능금액 */
  availableCash: number;
  realizedPnl: number;
  positions: Array<{
    symbol: string;
    name: string;
    qty: number;
    sellable: number;
    avgPrice: number;
    lastPrice: number;
    value: number;
    pnl: number;
    /** % 소수 둘째 자리 */
    pnlRate: number;
  }>;
  totals: { purchase: number; value: number; pnl: number; pnlRate: number; equity: number };
}

const rate = (pnl: number, base: number) => (base > 0 ? Math.round((pnl / base) * 10_000) / 100 : 0);

export class Ledger {
  private readonly accounts = new Map<string, Account>();

  constructor(
    private readonly market: Market,
    seeds: Record<string, AccountSeed> = SEED_ACCOUNTS,
  ) {
    for (const [userId, seed] of Object.entries(seeds)) this.open(userId, seed);
  }

  open(userId: string, seed: AccountSeed): void {
    this.accounts.set(userId, {
      userId,
      accountNo: seed.accountNo,
      cash: seed.cash,
      realizedPnl: 0,
      positions: new Map(Object.entries(seed.positions ?? {}).map(([s, p]) => [s, { ...p }])),
      reservations: new Map(),
      appliedFills: new Map(),
    });
  }

  has(userId: string): boolean {
    return this.accounts.has(userId);
  }

  limits(userId: string, symbol: string): AccountLimits {
    const account = this.require(userId);
    let reservedCash = 0;
    let reservedQty = 0;
    for (const r of account.reservations.values()) {
      if (r.side === 'bid') reservedCash += r.unit * r.qty;
      else if (r.symbol === symbol) reservedQty += r.qty;
    }
    return {
      availableCash: Math.max(0, account.cash - reservedCash),
      sellableQty: Math.max(0, (account.positions.get(symbol)?.qty ?? 0) - reservedQty),
    };
  }

  /**
   * 접수 전 확인(C++ checkAccount). 정정이면 원주문에서 옮겨 올 수량만큼은 이미 묶여 있으니 더해서 본다.
   */
  check(
    userId: string,
    symbol: string,
    order: { side: 'bid' | 'ask'; type: 'limit' | 'market'; price: number; qty: number },
    releasing?: { key: string; qty: number },
  ): RejectReason {
    // 계좌 없는 사용자는 주문 API가 먼저 403 NO_ACCOUNT로 막는다(api/orders.ts). 여기서는 확인할 원장이 없을 뿐
    if (!this.accounts.has(userId)) return 'NONE';
    const limits = this.limits(userId, symbol);
    if (releasing) {
      const r = this.require(userId).reservations.get(releasing.key);
      if (r?.side === 'bid') limits.availableCash += r.unit * releasing.qty;
      else if (r) limits.sellableQty += releasing.qty;
    }
    return checkAccount(order, limits, this.market.upperLimit(symbol));
  }

  orderable(userId: string, symbol: string, side: 'bid' | 'ask', type: 'limit' | 'market', price: number) {
    const limits = this.limits(userId, symbol);
    const upper = this.market.upperLimit(symbol);
    return {
      ...limits,
      maxQty: maxOrderQty({ side, type, price }, limits, upper),
      unitPrice: type === 'market' ? upper : price,
    };
  }

  /** 주문 기록이 바뀔 때마다(OrderTracker) 체결분 반영 + 묶음을 잔량에 맞춘다 */
  onRecord(record: OrderRecord): void {
    const account = this.accounts.get(record.userId);
    if (!account || record.orderId === 0) return;
    const applied = account.appliedFills.get(record.key) ?? 0;
    for (const fill of record.fills.slice(applied)) this.applyFill(account, record, fill);
    account.appliedFills.set(record.key, record.fills.length);

    if (record.resting > 0) {
      const unit = record.side === 'bid' ? (record.type === 'market' ? this.market.upperLimit(record.symbol) : record.price) : 0;
      account.reservations.set(record.key, { symbol: record.symbol, side: record.side, unit, qty: record.resting });
    } else {
      account.reservations.delete(record.key);
    }
  }

  summary(userId: string): AccountSummary {
    const account = this.require(userId);
    let reservedCash = 0;
    for (const r of account.reservations.values()) if (r.side === 'bid') reservedCash += r.unit * r.qty;
    const positions = [...account.positions.entries()]
      .filter(([, p]) => p.qty > 0)
      .map(([symbol, p]) => {
        const lastPrice = this.market.lastPrice(symbol);
        const purchase = Math.round(p.avgPrice * p.qty);
        const value = lastPrice * p.qty;
        return {
          symbol,
          name: this.market.info(symbol).name,
          qty: p.qty,
          sellable: this.limits(userId, symbol).sellableQty,
          avgPrice: Math.round(p.avgPrice),
          lastPrice,
          value,
          pnl: value - purchase,
          pnlRate: rate(value - purchase, purchase),
        };
      })
      .sort((a, b) => b.value - a.value);
    const purchase = positions.reduce((s, p) => s + Math.round(p.avgPrice * p.qty), 0);
    const value = positions.reduce((s, p) => s + p.value, 0);
    return {
      accountNo: account.accountNo,
      cash: account.cash,
      reservedCash,
      availableCash: Math.max(0, account.cash - reservedCash),
      realizedPnl: account.realizedPnl,
      positions,
      totals: { purchase, value, pnl: value - purchase, pnlRate: rate(value - purchase, purchase), equity: account.cash + value },
    };
  }

  private applyFill(account: Account, record: OrderRecord, fill: { price: number; qty: number }): void {
    const amount = fill.price * fill.qty;
    const pos = account.positions.get(record.symbol) ?? { qty: 0, avgPrice: 0 };
    if (record.side === 'bid') {
      account.cash -= amount;
      pos.avgPrice = (pos.avgPrice * pos.qty + amount) / (pos.qty + fill.qty);
      pos.qty += fill.qty;
      account.positions.set(record.symbol, pos);
    } else {
      account.cash += amount;
      account.realizedPnl += Math.round((fill.price - pos.avgPrice) * fill.qty);
      pos.qty -= fill.qty;
      if (pos.qty <= 0) account.positions.delete(record.symbol);
      else account.positions.set(record.symbol, pos);
    }
  }

  private require(userId: string): Account {
    const account = this.accounts.get(userId);
    if (!account) throw new Error(`no account for ${userId}`);
    return account;
  }
}
