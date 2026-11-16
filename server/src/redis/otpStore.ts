/** Redis OTP 저장소(시드는 OtpService가 이미 암호화한 값을 넣는다) */
import type { Redis } from 'ioredis';

import type { OtpRecord, OtpStore } from '../auth/otp.js';

export class RedisOtpStore implements OtpStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'hoga:otp:',
  ) {}

  async get(userId: string): Promise<OtpRecord | undefined> {
    const raw = await this.redis.get(this.prefix + userId);
    return raw ? (JSON.parse(raw) as OtpRecord) : undefined;
  }

  async set(userId: string, record: OtpRecord): Promise<void> {
    await this.redis.set(this.prefix + userId, JSON.stringify(record));
  }

  async delete(userId: string): Promise<void> {
    await this.redis.del(this.prefix + userId);
  }
}
