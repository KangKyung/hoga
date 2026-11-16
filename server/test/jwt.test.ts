import { describe, expect, it } from 'vitest';

import { AuthService } from '../src/auth/auth.js';
import { JwtError, signAccessToken, verifyAccessToken } from '../src/auth/jwt.js';
import { UserStore } from '../src/auth/users.js';
import { loadConfig } from '../src/config.js';

const SECRET = 'test-secret-0123456789';

describe('HS256 JWT', () => {
  it('서명한 토큰을 검증하고 클레임을 돌려준다', () => {
    const token = signAccessToken(SECRET, { sub: 'u1', name: 'n' }, 60, 1000);
    expect(verifyAccessToken(SECRET, token, 1030)).toMatchObject({ sub: 'u1', exp: 1060 });
  });

  it('만료·위조·형식 오류를 구분한다', () => {
    const token = signAccessToken(SECRET, { sub: 'u1', name: 'n' }, 60, 1000);
    expect(() => verifyAccessToken(SECRET, token, 1060)).toThrow(new JwtError('EXPIRED'));
    expect(() => verifyAccessToken('other-secret-0123456', token, 1000)).toThrow(new JwtError('BAD_SIGNATURE'));
    const [h, , sig] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin', exp: 9e9 })).toString('base64url')}.${sig}`;
    expect(() => verifyAccessToken(SECRET, forged, 1000)).toThrow(new JwtError('BAD_SIGNATURE'));
    expect(() => verifyAccessToken(SECRET, 'a.b', 1000)).toThrow(new JwtError('MALFORMED'));
  });

  it('alg=none 헤더는 받지 않는다', () => {
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"x","exp":9e9}').toString('base64url')}.`;
    expect(() => verifyAccessToken(SECRET, none, 1000)).toThrow(new JwtError('MALFORMED'));
  });
});

describe('로그인 실패 제한 · 운영 설정', () => {
  const auth = () =>
    new AuthService(new UserStore(), { secret: SECRET, accessTtlSec: 60, refreshTtlSec: 600, maxFailuresPerMinute: 3, maxFailuresPerMinutePerIp: 5 });

  it('사용자 이름을 바꿔 가며 시도해도 같은 IP는 막힌다', async () => {
    const service = auth();
    for (let i = 0; i < 5; i++) {
      await expect(service.login(`nobody${i}`, 'x', '10.0.0.1')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    }
    await expect(service.login('demo', 'hoga-demo-1234', '10.0.0.1')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    // 다른 IP의 정상 사용자는 영향 없음
    await expect(service.login('demo', 'hoga-demo-1234', '10.0.0.2')).resolves.toHaveProperty('accessToken');
  });

  it('NODE_ENV=production이면 공개된 개발용 비밀값으로 시작하지 않는다', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET, OTP_ENC_KEY, ADMIN_TOKEN/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32), OTP_ENC_KEY: 'y'.repeat(32), ADMIN_TOKEN: 'z'.repeat(24) }),
    ).not.toThrow();
    expect(() => loadConfig({})).not.toThrow(); // 개발은 그대로
  });
});
