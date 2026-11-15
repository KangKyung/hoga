import { describe, expect, it } from 'vitest';

import { InMemoryIdempotencyStore } from '../src/idempotency.js';

describe('InMemoryIdempotencyStore', () => {
  it('처음 키는 new, 완료 후 같은 내용은 처음 결과를 돌려준다', async () => {
    const store = new InMemoryIdempotencyStore<string>(1000);
    expect(await store.begin('k1', 'A')).toEqual({ state: 'new' });
    expect(await store.begin('k1', 'A')).toEqual({ state: 'pending' });
    await store.complete('k1', 'result');
    expect(await store.begin('k1', 'A')).toEqual({ state: 'done', result: 'result' });
  });

  it('같은 키에 다른 내용은 conflict', async () => {
    const store = new InMemoryIdempotencyStore<string>(1000);
    await store.begin('k1', 'A');
    expect(await store.begin('k1', 'B')).toEqual({ state: 'conflict' });
  });

  it('abandon은 처리 중인 키만 풀어 재시도를 허용한다', async () => {
    const store = new InMemoryIdempotencyStore<string>(1000);
    await store.begin('k1', 'A');
    await store.abandon('k1');
    expect(await store.begin('k1', 'A')).toEqual({ state: 'new' });
    await store.complete('k1', 'done');
    await store.abandon('k1');
    expect(await store.begin('k1', 'A')).toEqual({ state: 'done', result: 'done' });
  });

  it('TTL이 지나면 키가 사라진다', async () => {
    let now = 0;
    const store = new InMemoryIdempotencyStore<string>(1000, () => now);
    await store.begin('k1', 'A');
    await store.complete('k1', 'r');
    now = 999;
    expect((await store.begin('k1', 'A')).state).toBe('done');
    now = 1000;
    expect(await store.begin('k1', 'A')).toEqual({ state: 'new' });
    now = 5000;
    expect(store.sweep()).toBe(1);
  });
});
