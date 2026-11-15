import { describe, expect, it } from 'vitest';

import { JwtError, signAccessToken, verifyAccessToken } from '../src/auth/jwt.js';

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
