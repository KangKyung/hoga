import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 최소 HS256 JWT. 외부 라이브러리 없이 node:crypto만 쓴다.
 * - 알고리즘은 HS256으로 고정(헤더의 alg를 믿지 않는다 → alg=none 공격 차단)
 * - 서명 비교는 timingSafeEqual
 * - exp는 반드시 검사
 */
export interface AccessClaims {
  sub: string;
  name: string;
  iat: number;
  exp: number;
  jti: string;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');
const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

export class JwtError extends Error {
  constructor(readonly code: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED') {
    super(code);
  }
}

export function signAccessToken(
  secret: string,
  claims: { sub: string; name: string },
  ttlSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const payload: AccessClaims = {
    ...claims,
    iat: nowSec,
    exp: nowSec + ttlSec,
    jti: randomBytes(8).toString('hex'),
  };
  const body = `${HEADER}.${b64url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyAccessToken(
  secret: string,
  token: string,
  nowSec = Math.floor(Date.now() / 1000),
): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) throw new JwtError('MALFORMED');
  const [header, payload, signature] = parts as [string, string, string];

  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError('BAD_SIGNATURE');
  }

  let claims: AccessClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccessClaims;
  } catch {
    throw new JwtError('MALFORMED');
  }
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') throw new JwtError('MALFORMED');
  if (claims.exp <= nowSec) throw new JwtError('EXPIRED');
  return claims;
}
