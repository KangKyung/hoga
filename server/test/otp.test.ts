import { afterEach, describe, expect, it } from 'vitest';

import { createServer, type HogaServer } from '../src/app.js';
import { InMemoryOtpStore, OtpService } from '../src/auth/otp.js';
import { base32Decode, base32Encode, codeAt, stepAt, verifyCode } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 부록 B, SHA1 시드 "12345678901234567890"(8자리 값의 끝 6자리)
  const seed = Buffer.from('12345678901234567890');
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('t=%i → %s', (t, code) => {
    expect(codeAt(seed, Math.floor(t / 30))).toBe(code);
  });

  it('round-trips base32', () => {
    expect(base32Decode(base32Encode(seed))).toEqual(seed);
    expect(base32Encode(seed)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('accepts ±1 step, rejects reuse of the same or an older step', () => {
    const secret = base32Encode(seed);
    const now = 1_794_790_000_000;
    const prev = codeAt(seed, stepAt(now) - 1);
    const next = codeAt(seed, stepAt(now) + 1);
    const far = codeAt(seed, stepAt(now) + 3);
    expect(verifyCode(secret, prev, now)).toBe(stepAt(now) - 1);
    expect(verifyCode(secret, next, now)).toBe(stepAt(now) + 1);
    expect(verifyCode(secret, far, now)).toBeNull();
    const used = verifyCode(secret, codeAt(seed, stepAt(now)), now)!;
    expect(verifyCode(secret, codeAt(seed, stepAt(now)), now, used)).toBeNull(); // 같은 코드 재사용
    expect(verifyCode(secret, prev, now, used)).toBeNull(); // 더 이전 코드
    expect(verifyCode(secret, '12345', now)).toBeNull();
  });
});

describe('OtpService', () => {
  const make = (now: { t: number }) => new OtpService(new InMemoryOtpStore(), 'k'.repeat(32), 'jwt-secret-xxxxxxxx', () => now.t);
  const code = (secret: string, t: number) => codeAt(base32Decode(secret), stepAt(t));

  it('needs confirmation before it is active, then issues a step-up token that allows orders', async () => {
    const now = { t: 1_794_790_000_000 };
    const otp = make(now);
    expect(await otp.allowsOrder('u1', undefined)).toBe(true); // OTP를 안 켰으면 그대로
    const { secret, otpauthUrl } = await otp.enroll('u1', 'demo');
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(await otp.allowsOrder('u1', undefined)).toBe(true); // 확인 전에는 비활성
    await otp.confirm('u1', code(secret, now.t));
    expect(await otp.allowsOrder('u1', undefined)).toBe(false);
    now.t += 30_000;
    const { stepUpToken } = await otp.verify('u1', code(secret, now.t));
    expect(await otp.allowsOrder('u1', stepUpToken)).toBe(true);
    // 다른 사용자(OTP 켬)의 주문에는 쓸 수 없다
    const other = await otp.enroll('u2', 'trader2');
    await otp.confirm('u2', code(other.secret, now.t));
    expect(await otp.allowsOrder('u2', stepUpToken)).toBe(false);
    now.t += 11 * 60_000; // 10분 지나면 만료
    expect(await otp.allowsOrder('u1', stepUpToken)).toBe(false);
  });

  it('locks after 5 wrong codes in 5 minutes', async () => {
    const now = { t: 1_794_790_000_000 };
    const otp = make(now);
    const { secret } = await otp.enroll('u1', 'demo');
    await otp.confirm('u1', code(secret, now.t));
    for (let i = 0; i < 4; i++) await expect(otp.verify('u1', '000000')).rejects.toMatchObject({ code: 'OTP_INVALID' });
    await expect(otp.verify('u1', '000000')).rejects.toMatchObject({ code: 'OTP_LOCKED' });
    now.t += 30_000;
    await expect(otp.verify('u1', code(secret, now.t))).rejects.toMatchObject({ code: 'OTP_LOCKED' }); // 맞아도 잠금
    now.t += 5 * 60_000;
    await expect(otp.verify('u1', code(secret, now.t))).resolves.toHaveProperty('stepUpToken');
  });

  it('stores the seed encrypted', async () => {
    const store = new InMemoryOtpStore();
    const otp = new OtpService(store, 'k'.repeat(32), 'jwt-secret-xxxxxxxx');
    const { secret } = await otp.enroll('u1', 'demo');
    const stored = await store.get('u1');
    expect(stored?.secret).not.toContain(secret);
    expect(stored?.secret.split('.')).toHaveLength(3);
  });
});

const servers: HogaServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

describe('orders with OTP', () => {
  it('requires a step-up token; the same idempotency key works after OTP', async () => {
    const server = createServer(loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', SIM_INTERVAL_MS: '0' }));
    await server.start();
    servers.push(server);
    const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${server.url()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, string> };
    };
    const { body: login } = await call('/auth/login', { username: 'trader2', password: 'hoga-trader-5678' });
    const auth = { authorization: `Bearer ${login.accessToken}` };
    const { body: enroll } = await call('/auth/otp/enroll', {}, auth);
    const now = () => codeAt(base32Decode(enroll.secret!), stepAt(Date.now()));
    expect((await call('/auth/otp/confirm', { code: now() }, auth)).body).toEqual({ enabled: true });

    const order = { symbol: '000001', side: 'bid', type: 'limit', price: 60_000, qty: 1 };
    const headers = { ...auth, 'idempotency-key': 'otp-order-0001' };
    expect(await call('/orders', order, headers)).toEqual({ status: 403, body: { error: 'OTP_REQUIRED' } });
    // 확인 때 쓴 코드는 다시 못 쓴다 → 다음 구간 코드가 필요할 수 있어 재사용 거부만 확인
    expect((await call('/auth/otp/verify', { code: now() }, auth)).status).toBe(401);
    const stepT = (stepAt(Date.now()) + 1) * 30_000;
    const nextCode = codeAt(base32Decode(enroll.secret!), stepAt(stepT)); // 다음 구간(±1 허용)
    const { body: verified } = await call('/auth/otp/verify', { code: nextCode }, auth);
    const ok = await call('/orders', order, { ...headers, 'x-step-up': verified.stepUpToken! });
    expect(ok.status).toBe(200);
    // 액세스 토큰을 step-up 자리에 넣어도 통하지 않는다
    expect((await call('/orders', order, { ...headers, 'idempotency-key': 'otp-order-0002', 'x-step-up': login.accessToken! })).status).toBe(403);
    // 관리자 초기화(분실) → OTP 없이 주문, 다시 등록 가능
    expect((await call('/admin/api/otp/reset', { userId: 'u-trader2' }, { 'x-admin-token': 'hoga-admin-dev-token' })).body).toEqual({ ok: true });
    expect((await call('/orders', order, { ...headers, 'idempotency-key': 'otp-order-0003' })).status).toBe(200);
    expect((await call('/auth/otp/enroll', {}, auth)).status).toBe(200);
  });
});
