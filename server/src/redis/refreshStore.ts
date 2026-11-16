/**
 * Redis 리프레시 토큰 저장소. 서버를 재시작하거나 여러 대로 늘려도 로그인이 유지된다.
 * consume은 Lua로 "아직 안 썼으면 used=1" 을 원자적으로 해서, 같은 토큰으로 동시에 두 번 와도 하나만 성공한다.
 */
import type { Redis } from 'ioredis';

import type { ConsumeResult, RefreshEntry, RefreshStore } from '../auth/refreshStore.js';

const CONSUME = `
if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
local used = redis.call('HGET', KEYS[1], 'used')
redis.call('HSET', KEYS[1], 'used', '1')
return {used, redis.call('HGET', KEYS[1], 'userId'), redis.call('HGET', KEYS[1], 'familyId'), redis.call('HGET', KEYS[1], 'expiresAt')}`;

export class RedisRefreshStore implements RefreshStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'hoga:refresh:',
  ) {}

  async save(hash: string, entry: RefreshEntry): Promise<void> {
    const k = this.prefix + hash;
    await this.redis
      .multi()
      .hset(k, { userId: entry.userId, familyId: entry.familyId, expiresAt: String(entry.expiresAt), used: '0' })
      .pexpireat(k, entry.expiresAt)
      .exec();
  }

  async consume(hash: string): Promise<ConsumeResult> {
    const r = (await this.redis.eval(CONSUME, 1, this.prefix + hash)) as [string, string, string, string] | null;
    if (!r) return { state: 'missing' };
    const entry: RefreshEntry = { userId: r[1], familyId: r[2], expiresAt: Number(r[3]) };
    return r[0] === '1' ? { state: 'reused', entry } : { state: 'ok', entry };
  }

  async peek(hash: string): Promise<RefreshEntry | undefined> {
    const h = await this.redis.hgetall(this.prefix + hash);
    if (!h.userId) return undefined;
    return { userId: h.userId, familyId: h.familyId!, expiresAt: Number(h.expiresAt) };
  }

  async revokeFamily(familyId: string, ttlMs: number): Promise<void> {
    await this.redis.set(`${this.prefix}revoked:${familyId}`, '1', 'PX', ttlMs);
  }

  async isRevoked(familyId: string): Promise<boolean> {
    return (await this.redis.exists(`${this.prefix}revoked:${familyId}`)) === 1;
  }
}
