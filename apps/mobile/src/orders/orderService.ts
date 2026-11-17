import {HttpError, NetworkError, TimeoutError, request} from '../api/http';
import {stepUpToken} from '../auth/otp';
import {session} from '../auth/session';
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
/** 다른 사용자의 미확정 주문을 남겨 두는 기간(리프레시 토큰 수명과 같음) */
export const OTHER_USER_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 미확정 주문 목록. 보안 저장소(Keychain·Keystore)에 JSON으로 둔다.
 * 읽고-고치고-쓰기가 겹치지 않도록 작업을 한 줄로 세운다.
 * 주문마다 사용자를 적고, 목록은 지금 로그인한 사용자 것만 돌려준다. 다른 사용자 것은 그 사용자가
 * 다시 로그인할 때까지 그대로 둔다(로그아웃해도 지우지 않는다 — 접수 여부를 아직 모른다).
 * 사용자 표시가 없는 예전 항목은 지금 사용자 것으로 본다.
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

function currentUserId(): string | undefined {
  const state = session.getState();
  return state.status === 'signedIn' ? state.user.id : undefined;
}

export const pendingOrders = {
  list: () =>
    serial(async () => {
      const userId = currentUserId();
      if (!userId) return [];
      const all = await readPending();
      // 다른 사용자 항목은 그 사용자가 다시 로그인할 때까지 두지만, 리프레시 토큰 수명(7일)이 지나면
      // 그 사용자도 다시 로그인해야 하고 서버 멱등 키(24시간)도 사라졌으니 확인할 길이 없다 → 정리
      const now = Date.now();
      const kept = all.filter(o => !o.userId || o.userId === userId || now - o.createdAt < OTHER_USER_PENDING_TTL_MS);
      if (kept.length !== all.length) await secureStore.set(PENDING_KEY, JSON.stringify(kept));
      return kept.filter(o => !o.userId || o.userId === userId);
    }),
  add: (order: PendingOrder) =>
    serial(async () => {
      const list = await readPending();
      const mine = {...order, userId: order.userId ?? currentUserId()};
      await secureStore.set(PENDING_KEY, JSON.stringify([...list.filter(o => o.key !== order.key), mine]));
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
        ...(draft.amendOf ? {amendOf: draft.amendOf} : {}),
      },
    });
    return {kind: 'ok', record: data};
  } catch (e) {
    if (e instanceof TimeoutError || e instanceof NetworkError) return {kind: 'unknown'};
    if (e instanceof HttpError) {
      // 처리 중·과부하·서버 오류는 결과를 모르는 것 → 조회로 확정
      if (e.status === 409 || e.status === 429 || e.status >= 500) return {kind: 'unknown'};
      if (e.status === 403 && e.body.error === 'OTP_REQUIRED') return {kind: 'otp_required'};
      // 계좌가 없다 = 재시작으로 사라진 개설 계정의 남은 토큰. 갱신이 실패(401)하면 세션이 로그인 화면으로 돌아간다
      if (e.status === 403 && e.body.error === 'NO_ACCOUNT') session.tokens.refresh().catch(() => {});
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
    // 재시작 전 market이 처리했지만 지금은 없는 주문(다시 보내도 같은 답)
    if (e instanceof HttpError && e.status === 410) return {kind: 'lost'};
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
  /** 미체결(잔량이 남은 주문) */
  open: async () => (await request<OrderRecord[]>('/orders?status=open', {auth: true})).data,
  cancel: async (key: string) =>
    (await request<{status: string; reject: string}>(`/orders/${encodeURIComponent(key)}/cancel`, {method: 'POST', auth: true}))
      .data,
};
