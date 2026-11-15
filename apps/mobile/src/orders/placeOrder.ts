import type {OrderDraft, OrderRecord, PendingOrder} from './types';

/**
 * 주문 전송 상태 머신.
 *
 *   submitting ──200──────────────▶ accepted / rejected(업무 거부)
 *       │
 *       ├─ 타임아웃·네트워크 오류·5xx·409 ─▶ confirming ── GET /orders/:key
 *       │                                     ├─ 있음 ─────────▶ accepted / rejected
 *       │                                     ├─ 처리 중(202) ─▶ 잠시 후 다시 조회
 *       │                                     └─ 없음(404) ────▶ 같은 키로 다시 전송
 *       └─ 400·422 등 확정 오류 ─────────────▶ failed
 *
 * 원칙
 * - "응답이 늦다 = 실패"가 아니다. 서버가 이미 접수했을 수 있으므로 조회로 확정한다.
 * - 재전송은 항상 같은 Idempotency-Key → 서버가 한 번만 처리한다.
 * - 보내기 전에 미확정 주문으로 먼저 기록(write-ahead). 앱이 도중에 죽어도 다음 실행 때 확정한다.
 * - 끝까지 확정 못 하면 "실패"라고 단정하지 않고, 확인할 수 없었다고 알린다.
 */
export type OrderPhase = 'submitting' | 'confirming' | 'accepted' | 'rejected' | 'failed';

export interface OrderProgress {
  phase: OrderPhase;
  key: string;
  attempt: number;
  record?: OrderRecord;
  message?: string;
}

export type PostResult = {kind: 'ok'; record: OrderRecord} | {kind: 'unknown'} | {kind: 'error'; message: string};
export type LookupResult = {kind: 'found'; record: OrderRecord} | {kind: 'in_progress'} | {kind: 'not_found'} | {kind: 'unknown'};

export interface OrderDeps {
  newKey(): string;
  /** 성공=ok, 결과 모름(타임아웃 등)=unknown, 확정 오류=error */
  post(key: string, draft: OrderDraft): Promise<PostResult>;
  lookup(key: string): Promise<LookupResult>;
  pending: {
    add(order: PendingOrder): Promise<void>;
    remove(key: string): Promise<void>;
  };
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const MAX_SENDS = 3;
export const LOOKUPS_PER_SEND = 3;
export const LOOKUP_BACKOFF_MS = [500, 1000, 2000];

function settle(key: string, attempt: number, record: OrderRecord): OrderProgress {
  if (record.status === 'REJECTED') {
    return {phase: 'rejected', key, attempt, record, message: record.reject};
  }
  return {phase: 'accepted', key, attempt, record};
}

export async function placeOrder(
  draft: OrderDraft,
  deps: OrderDeps,
  onProgress: (p: OrderProgress) => void = () => {},
): Promise<OrderProgress> {
  const key = deps.newKey();
  await deps.pending.add({key, draft, createdAt: deps.now()});

  const finish = async (p: OrderProgress) => {
    if (p.phase !== 'failed' || p.message !== UNCONFIRMED) await deps.pending.remove(key);
    onProgress(p);
    return p;
  };

  for (let attempt = 1; attempt <= MAX_SENDS; attempt++) {
    onProgress({phase: 'submitting', key, attempt});
    const posted = await deps.post(key, draft);
    if (posted.kind === 'ok') return finish(settle(key, attempt, posted.record));
    if (posted.kind === 'error') return finish({phase: 'failed', key, attempt, message: posted.message});

    // 결과 모름 → 조회로 확정
    onProgress({phase: 'confirming', key, attempt});
    let notFound = false;
    for (let i = 0; i < LOOKUPS_PER_SEND; i++) {
      await deps.sleep(LOOKUP_BACKOFF_MS[i] ?? 2000);
      const found = await deps.lookup(key);
      if (found.kind === 'found') return finish(settle(key, attempt, found.record));
      if (found.kind === 'not_found') {
        notFound = true; // 서버에 도착하지 않았다 → 같은 키로 다시 보낸다
        break;
      }
      // in_progress·unknown → 조금 더 기다렸다가 다시 조회
    }
    if (!notFound && attempt === MAX_SENDS) break;
  }

  return finish({phase: 'failed', key, attempt: MAX_SENDS, message: UNCONFIRMED});
}

/** 끝까지 확정하지 못한 경우. 미확정 기록을 남겨 다음 실행 때 다시 확인한다. */
export const UNCONFIRMED = 'UNCONFIRMED';

export interface ReconcileResult {
  confirmed: OrderRecord[];
  /** 서버에 도착하지 않은 주문. 자동으로 다시 보내지 않는다(사용자의 판단이 바뀌었을 수 있다) */
  notSent: PendingOrder[];
  stillUnknown: PendingOrder[];
}

/** 앱 시작·로그인 시 미확정 주문을 서버 조회로 정리한다. */
export async function reconcilePending(
  list: PendingOrder[],
  deps: Pick<OrderDeps, 'lookup' | 'pending'>,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {confirmed: [], notSent: [], stillUnknown: []};
  for (const order of list) {
    const found = await deps.lookup(order.key);
    if (found.kind === 'found') {
      result.confirmed.push(found.record);
      await deps.pending.remove(order.key);
    } else if (found.kind === 'not_found') {
      result.notSent.push(order);
      await deps.pending.remove(order.key);
    } else {
      result.stillUnknown.push(order);
    }
  }
  return result;
}
