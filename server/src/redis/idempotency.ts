/**
 * Redis 멱등 키 저장소. 여러 market 인스턴스·재시작에도 "한 번만 처리"를 지킨다.
 * - begin: SET key {fp} NX PX ttl  → 처음이면 new
 * - complete: 결과를 넣되 남은 TTL 유지(KEEPTTL)
 * - abandon: 결과가 아직 없을 때만 지운다(Lua로 원자적으로)
 */
import type { Redis } from 'ioredis';

import type { BeginResult, IdempotencyStore } from '../idempotency.js';

interface Stored<T> {
  fp: string;
  result?: T;
}

const ABANDON = `
local v = redis.call('GET', KEYS[1])
if v and not string.find(v, '"result"', 1, true) then return redis.call('DEL', KEYS[1]) end
return 0`;

export class RedisIdempotencyStore<T> implements IdempotencyStore<T> {
  constructor(
    private readonly redis: Redis,
    private readonly ttlMs: number,
    private readonly prefix = 'hoga:idem:',
  ) {}

  async begin(key: string, fingerprint: string): Promise<BeginResult<T>> {
    const k = this.prefix + key;
    const ok = await this.redis.set(k, JSON.stringify({ fp: fingerprint } satisfies Stored<T>), 'PX', this.ttlMs, 'NX');
    if (ok === 'OK') return { state: 'new' };
    const raw = await this.redis.get(k);
    if (raw === null) return this.begin(key, fingerprint); // 그 사이 만료됨
    const stored = JSON.parse(raw) as Stored<T>;
    if (stored.fp !== fingerprint) return { state: 'conflict' };
    return stored.result === undefined ? { state: 'pending' } : { state: 'done', result: stored.result };
  }

  async complete(key: string, result: T): Promise<void> {
    const k = this.prefix + key;
    const raw = await this.redis.get(k);
    const fp = raw ? (JSON.parse(raw) as Stored<T>).fp : '';
    await this.redis.set(k, JSON.stringify({ fp, result } satisfies Stored<T>), 'KEEPTTL');
  }

  async abandon(key: string): Promise<void> {
    await this.redis.eval(ABANDON, 1, this.prefix + key);
  }

  async get(key: string): Promise<{ fingerprint: string; result?: T } | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as Stored<T>;
    return { fingerprint: stored.fp, result: stored.result };
  }

  /** Redis가 TTL로 지우므로 할 일이 없다(메모리 구현과 같은 모양) */
  sweep(): number {
    return 0;
  }
}
