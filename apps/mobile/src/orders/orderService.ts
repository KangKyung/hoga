import {HttpError, NetworkError, TimeoutError, request} from '../api/http';
import {stepUpToken} from '../auth/otp';
import {ORDER_TIMEOUT_MS} from '../config';
import {hogaCore} from '../native/hogaCore';
import {secureStore} from '../native/security';
import {
  placeOrder as runPlaceOrder,
  reconcilePending as runReconcile,
  type LookupResult,
  type OrderDeps,
  type OrderProgress,
  type PostResult,
} from './placeOrder';
import type {OrderDraft, OrderRecord, PendingOrder} from './types';

const PENDING_KEY = 'orders.pending';

/**
 * 미확정 주문 목록. 보안 저장소(Keychain·Keystore)에 JSON으로 둔다.
 * 읽고-고치고-쓰기가 겹치지 않도록 작업을 한 줄로 세운다.
 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function readPending(): Promise<PendingOrder[]> {
  const raw = await secureStore.get(PENDING_KEY);
  try {
    return raw ? (JSON.parse(raw) as PendingOrder[]) : [];
  } catch {
    return [];
  }
}

export const pendingOrders = {
  list: () => serial(readPending),
  add: (order: PendingOrder) =>
    serial(async () => {
      const list = await readPending();
      await secureStore.set(PENDING_KEY, JSON.stringify([...list.filter(o => o.key !== order.key), order]));
    }),
  remove: (key: string) =>
    serial(async () => {
      const list = await readPending();
      await secureStore.set(PENDING_KEY, JSON.stringify(list.filter(o => o.key !== key)));
    }),
};

async function post(key: string, draft: OrderDraft): Promise<PostResult> {
  try {
    const {data} = await request<OrderRecord>('/orders', {
      method: 'POST',
      auth: true,
      timeoutMs: ORDER_TIMEOUT_MS,
      headers: {'idempotency-key': key, ...(stepUpToken() ? {'x-step-up': stepUpToken()!} : {})},
      body: {
        symbol: draft.symbol,
        side: draft.side,
        type: draft.type,
        qty: draft.qty,
        ...(draft.type === 'limit' ? {price: draft.price} : {}),
      },
    });
    return {kind: 'ok', record: data};
  } catch (e) {
    if (e instanceof TimeoutError || e instanceof NetworkError) return {kind: 'unknown'};
    if (e instanceof HttpError) {
      // 처리 중·과부하·서버 오류는 결과를 모르는 것 → 조회로 확정
      if (e.status === 409 || e.status === 429 || e.status >= 500) return {kind: 'unknown'};
      if (e.status === 403 && e.body.error === 'OTP_REQUIRED') return {kind: 'otp_required'};
      return {kind: 'error', message: e.body.error ?? `HTTP_${e.status}`};
    }
    return {kind: 'unknown'};
  }
}

async function lookup(key: string): Promise<LookupResult> {
  try {
    const {status, data} = await request<OrderRecord>(`/orders/${encodeURIComponent(key)}`, {
      auth: true,
      timeoutMs: ORDER_TIMEOUT_MS,
    });
    return status === 202 ? {kind: 'in_progress'} : {kind: 'found', record: data};
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return {kind: 'not_found'};
    return {kind: 'unknown'};
  }
}

const deps: OrderDeps = {
  newKey: () => hogaCore.randomId(),
  post,
  lookup,
  pending: pendingOrders,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: Date.now,
};

export const orderService = {
  place: (draft: OrderDraft, onProgress: (p: OrderProgress) => void, requestOtp?: () => Promise<boolean>) =>
    runPlaceOrder(draft, {...deps, requestOtp}, onProgress),
  reconcile: async () => runReconcile(await pendingOrders.list(), deps),
  list: async (symbol?: string) =>
    (await request<OrderRecord[]>(`/orders${symbol ? `?symbol=${symbol}` : ''}`, {auth: true})).data,
  cancel: async (key: string) =>
    (await request<{status: string; reject: string}>(`/orders/${encodeURIComponent(key)}/cancel`, {method: 'POST', auth: true}))
      .data,
};
