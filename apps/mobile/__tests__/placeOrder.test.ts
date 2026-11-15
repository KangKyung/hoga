import {
  MAX_SENDS,
  UNCONFIRMED,
  placeOrder,
  reconcilePending,
  type LookupResult,
  type OrderDeps,
  type OrderProgress,
  type PostResult,
} from '../src/orders/placeOrder';
import type {OrderDraft, OrderRecord, PendingOrder} from '../src/orders/types';

const draft: OrderDraft = {symbol: '000001', side: 'bid', type: 'limit', price: 71_200, qty: 10};

function record(key: string, over: Partial<OrderRecord> = {}): OrderRecord {
  return {...draft, key, orderId: 7, status: 'NEW', reject: 'NONE', filled: 0, resting: 10, fills: [], acceptedAt: 0, updatedAt: 0, ...over};
}

function fakeDeps(posts: PostResult[], lookups: LookupResult[] = []) {
  const pending = new Map<string, PendingOrder>();
  const sentKeys: string[] = [];
  const deps: OrderDeps = {
    newKey: () => 'key-1',
    post: jest.fn(async (key: string): Promise<PostResult> => {
      sentKeys.push(key);
      return posts.shift() ?? {kind: 'unknown'};
    }),
    lookup: jest.fn(async (): Promise<LookupResult> => lookups.shift() ?? {kind: 'unknown'}),
    pending: {
      add: async o => {
        pending.set(o.key, o);
      },
      remove: async k => {
        pending.delete(k);
      },
    },
    sleep: async () => {},
    now: () => 1000,
  };
  return {deps, pending, sentKeys};
}

test('정상 접수: 미확정 기록을 남겼다가 지운다', async () => {
  const {deps, pending} = fakeDeps([{kind: 'ok', record: record('key-1')}]);
  const phases: string[] = [];
  const result = await placeOrder(draft, deps, p => phases.push(p.phase));
  expect(result.phase).toBe('accepted');
  expect(phases).toEqual(['submitting', 'accepted']);
  expect(pending.size).toBe(0);
});

test('응답 타임아웃이어도 서버가 접수했다면 조회로 "접수됨"을 확정한다(재전송 없음)', async () => {
  const {deps, sentKeys} = fakeDeps([{kind: 'unknown'}], [{kind: 'found', record: record('key-1')}]);
  const phases: OrderProgress['phase'][] = [];
  const result = await placeOrder(draft, deps, p => phases.push(p.phase));
  expect(result.phase).toBe('accepted');
  expect(phases).toEqual(['submitting', 'confirming', 'accepted']);
  expect(sentKeys).toEqual(['key-1']);
});

test('서버에 도착하지 않았다면(404) 같은 키로 다시 보낸다', async () => {
  const {deps, sentKeys} = fakeDeps(
    [{kind: 'unknown'}, {kind: 'ok', record: record('key-1')}],
    [{kind: 'not_found'}],
  );
  const result = await placeOrder(draft, deps);
  expect(result.phase).toBe('accepted');
  expect(result.attempt).toBe(2);
  expect(sentKeys).toEqual(['key-1', 'key-1']); // 같은 키 → 서버가 한 번만 처리
});

test('처리 중(202)이면 기다렸다가 다시 조회한다', async () => {
  const {deps} = fakeDeps([{kind: 'unknown'}], [{kind: 'in_progress'}, {kind: 'found', record: record('key-1')}]);
  const result = await placeOrder(draft, deps);
  expect(result.phase).toBe('accepted');
  expect(deps.lookup).toHaveBeenCalledTimes(2);
});

test('업무 거부(호가단위 등)는 재시도하지 않고 사유를 알려 준다', async () => {
  const {deps, pending} = fakeDeps([{kind: 'ok', record: record('key-1', {status: 'REJECTED', reject: 'OFF_TICK', orderId: 0})}]);
  const result = await placeOrder(draft, deps);
  expect(result).toMatchObject({phase: 'rejected', message: 'OFF_TICK'});
  expect(deps.post).toHaveBeenCalledTimes(1);
  expect(pending.size).toBe(0);
});

test('확정 오류(400·422)는 실패로 끝내고 미확정 기록도 지운다', async () => {
  const {deps, pending} = fakeDeps([{kind: 'error', message: 'IDEMPOTENCY_KEY_REUSED'}]);
  const result = await placeOrder(draft, deps);
  expect(result).toMatchObject({phase: 'failed', message: 'IDEMPOTENCY_KEY_REUSED'});
  expect(pending.size).toBe(0);
});

test('끝까지 확정하지 못하면 "확인 불가"로 끝내고 미확정 기록을 남긴다', async () => {
  const {deps, pending} = fakeDeps([]);
  const result = await placeOrder(draft, deps);
  expect(result).toMatchObject({phase: 'failed', message: UNCONFIRMED});
  expect(deps.post).toHaveBeenCalledTimes(MAX_SENDS);
  expect(pending.has('key-1')).toBe(true); // 다음 실행 때 reconcilePending이 확인
});

test('reconcilePending: 접수된 것·도착 안 한 것·아직 모르는 것을 나눈다', async () => {
  const list: PendingOrder[] = [
    {key: 'a', draft, createdAt: 0},
    {key: 'b', draft, createdAt: 0},
    {key: 'c', draft, createdAt: 0},
  ];
  const removed: string[] = [];
  const results: Record<string, LookupResult> = {
    a: {kind: 'found', record: record('a')},
    b: {kind: 'not_found'},
    c: {kind: 'unknown'},
  };
  const result = await reconcilePending(list, {
    lookup: async k => results[k]!,
    pending: {
      add: async () => {},
      remove: async k => {
        removed.push(k);
      },
    },
  });
  expect(result.confirmed.map(r => r.key)).toEqual(['a']);
  expect(result.notSent.map(o => o.key)).toEqual(['b']);
  expect(result.stillUnknown.map(o => o.key)).toEqual(['c']);
  expect(removed).toEqual(['a', 'b']); // 모르는 것은 남겨 둔다
});
