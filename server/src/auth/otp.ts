/**
 * 주문 2단계 인증(OTP).
 *
 * 등록: enroll(시드 발급, 아직 비활성) → confirm(앱에서 만든 코드로 확인해야 활성)
 * 주문: OTP를 켠 사용자는 verify로 받은 단기 "step-up" 토큰(10분)이 있어야 주문할 수 있다.
 * - 시드는 AES-256-GCM으로 암호화해 저장(저장소가 유출돼도 바로 쓸 수 없게)
 * - 5분에 5번 틀리면 5분 잠금
 * - step-up 토큰은 액세스 토큰과 다른 키(파생 키)로 서명해 서로 바꿔 쓸 수 없다
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { signAccessToken, verifyAccessToken } from './jwt.js';
import { generateSecret, otpauthUrl, verifyCode } from './totp.js';

export interface OtpRecord {
  /** 암호화된 시드(iv.tag.cipher, base64url) */
  secret: string;
  active: boolean;
  lastStep: number;
  failures: number[];
}

export interface OtpStore {
  get(userId: string): Promise<OtpRecord | undefined>;
  set(userId: string, record: OtpRecord): Promise<void>;
  delete(userId: string): Promise<void>;
}

export class InMemoryOtpStore implements OtpStore {
  private readonly map = new Map<string, OtpRecord>();
  async get(userId: string) {
    const r = this.map.get(userId);
    return r && { ...r, failures: [...r.failures] };
  }
  async set(userId: string, record: OtpRecord) {
    this.map.set(userId, { ...record, failures: [...record.failures] });
  }
  async delete(userId: string) {
    this.map.delete(userId);
  }
}

export type OtpFailure = 'OTP_NOT_ENROLLED' | 'OTP_ALREADY_ENABLED' | 'OTP_INVALID' | 'OTP_LOCKED' | 'OTP_NOT_ENABLED';

export class OtpError extends Error {
  constructor(readonly code: OtpFailure) {
    super(code);
  }
}

const MAX_FAILURES = 5;
const WINDOW_MS = 5 * 60_000;
export const STEP_UP_TTL_SEC = 10 * 60;

export class OtpService {
  private readonly key: Buffer;
  private readonly stepUpSecret: string;

  constructor(
    private readonly store: OtpStore,
    encryptionKey: string,
    jwtSecret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createHash('sha256').update(encryptionKey).digest();
    this.stepUpSecret = createHash('sha256').update(`${jwtSecret}:otp-step-up`).digest('hex');
  }

  async status(userId: string): Promise<{ enabled: boolean }> {
    return { enabled: (await this.store.get(userId))?.active ?? false };
  }

  async enroll(userId: string, account: string): Promise<{ secret: string; otpauthUrl: string }> {
    const existing = await this.store.get(userId);
    if (existing?.active) throw new OtpError('OTP_ALREADY_ENABLED');
    const secret = generateSecret();
    await this.store.set(userId, { secret: this.encrypt(secret), active: false, lastStep: -1, failures: [] });
    return { secret, otpauthUrl: otpauthUrl(secret, account) };
  }

  async confirm(userId: string, code: string): Promise<{ enabled: true }> {
    const record = await this.store.get(userId);
    if (!record) throw new OtpError('OTP_NOT_ENROLLED');
    if (record.active) throw new OtpError('OTP_ALREADY_ENABLED');
    await this.check(userId, record, code);
    record.active = true;
    await this.store.set(userId, record);
    return { enabled: true };
  }

  /** 주문 전 2단계 인증 → 단기 step-up 토큰 */
  async verify(userId: string, code: string): Promise<{ stepUpToken: string; expiresIn: number }> {
    const record = await this.store.get(userId);
    if (!record?.active) throw new OtpError('OTP_NOT_ENABLED');
    await this.check(userId, record, code);
    const now = Math.floor(this.now() / 1000);
    return { stepUpToken: signAccessToken(this.stepUpSecret, { sub: userId, name: 'otp' }, STEP_UP_TTL_SEC, now), expiresIn: STEP_UP_TTL_SEC };
  }

  async disable(userId: string, code: string): Promise<void> {
    const record = await this.store.get(userId);
    if (!record?.active) throw new OtpError('OTP_NOT_ENABLED');
    await this.check(userId, record, code);
    await this.store.delete(userId);
  }

  /** 관리자 초기화(본인 확인은 운영 절차). 다음 주문부터 OTP 없이, 다시 등록할 수 있다 */
  async reset(userId: string): Promise<void> {
    await this.store.delete(userId);
  }

  /** OTP를 켠 사용자면 유효한 step-up 토큰이 있어야 true */
  async allowsOrder(userId: string, stepUpToken: string | undefined): Promise<boolean> {
    const record = await this.store.get(userId);
    if (!record?.active) return true;
    if (!stepUpToken) return false;
    try {
      return verifyAccessToken(this.stepUpSecret, stepUpToken, Math.floor(this.now() / 1000)).sub === userId;
    } catch {
      return false;
    }
  }

  private async check(userId: string, record: OtpRecord, code: string): Promise<void> {
    const now = this.now();
    record.failures = record.failures.filter((t) => now - t < WINDOW_MS);
    if (record.failures.length >= MAX_FAILURES) throw new OtpError('OTP_LOCKED');
    const step = verifyCode(this.decrypt(record.secret), code, now, record.lastStep);
    if (step === null) {
      record.failures.push(now);
      await this.store.set(userId, record);
      throw new OtpError(record.failures.length >= MAX_FAILURES ? 'OTP_LOCKED' : 'OTP_INVALID');
    }
    record.lastStep = step;
    record.failures = [];
    await this.store.set(userId, record);
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
  }

  private decrypt(stored: string): string {
    const [iv, tag, data] = stored.split('.').map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}
