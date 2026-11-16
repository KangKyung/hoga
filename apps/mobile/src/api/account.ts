import {request} from './http';

export interface Position {
  symbol: string;
  name: string;
  qty: number;
  sellable: number;
  avgPrice: number;
  lastPrice: number;
  value: number;
  pnl: number;
  pnlRate: number;
}

/** 서버 Ledger.summary와 같은 모양 */
export interface AccountSummary {
  accountNo: string;
  cash: number;
  reservedCash: number;
  availableCash: number;
  realizedPnl: number;
  positions: Position[];
  totals: {purchase: number; value: number; pnl: number; pnlRate: number; equity: number};
}

export interface Orderable {
  availableCash: number;
  sellableQty: number;
  maxQty: number;
  unitPrice: number;
}

export const accountApi = {
  summary: async () => (await request<AccountSummary>('/account', {auth: true})).data,
  orderable: async (q: {symbol: string; side: 'bid' | 'ask'; type: 'limit' | 'market'; price: number}, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error('aborted');
    const params = `symbol=${q.symbol}&side=${q.side}&type=${q.type}&price=${q.type === 'limit' ? q.price : 0}`;
    return (await request<Orderable>(`/account/orderable?${params}`, {auth: true, timeoutMs: 4000})).data;
  },
};
