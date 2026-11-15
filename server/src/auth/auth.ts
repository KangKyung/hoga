import { createHash, randomBytes } from 'node:crypto';

import { signAccessToken, verifyAccessToken, type AccessClaims } from './jwt.js';
import type { User, UserStore } from './users.js';

export interface AuthConfig {
  secret: string;
  accessTtlSec: number;
  refreshTtlSec: number;
  /** 사용자 이름당 1분에 허용하는 로그인 실패 횟수 */
  maxFailuresPerMinute: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
}

interface RefreshEntry {
  userId: string;
  familyId: string;
  expiresAt: number;
  used: boolean;
}

export type AuthFailure = 'INVALID_CREDENTIALS' | 'TOO_MANY_ATTEMPTS' | 'INVALID_REFRESH' | 'REFRESH_REUSED';

export class AuthError extends Error {
  constructor(readonly code: AuthFailure) {
    super(code);
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * 로그인·토큰 발급.
 *
 * - 액세스 토큰: 짧은 수명 JWT(서버가 상태를 갖지 않고 검증)
 * - 리프레시 토큰: 긴 무작위 문자열, 서버에는 해시만 저장, 쓸 때마다 새 것으로 교체(회전)
 * - 재사용 감지: 이미 한 번 쓴 리프레시 토큰이 다시 오면 탈취로 보고 그 계열(family) 전체를 폐기
 * - 로그인 실패는 사용자 이름별로 1분에 N번까지만
 */
export class AuthService {
  private readonly refresh = new Map<string, RefreshEntry>();
  private readonly revokedFamilies = new Set<string>();
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly users: UserStore,
    private readonly config: AuthConfig,
    private readonly now: () => number = Date.now,
  ) {}

  login(username: string, password: string): TokenPair {
    const nowMs = this.now();
    const recent = (this.failures.get(username) ?? []).filter((t) => nowMs - t < 60_000);
    if (recent.length >= this.config.maxFailuresPerMinute) throw new AuthError('TOO_MANY_ATTEMPTS');

    const user = this.users.verify(username, password);
    if (!user) {
      this.failures.set(username, [...recent, nowMs]);
      throw new AuthError('INVALID_CREDENTIALS');
    }
    this.failures.delete(username);
    return this.issue(user, randomBytes(8).toString('hex'));
  }

  rotate(refreshToken: string): TokenPair {
    const key = sha256(refreshToken);
    const entry = this.refresh.get(key);
    if (!entry || entry.expiresAt <= this.now() || this.revokedFamilies.has(entry.familyId)) {
      throw new AuthError('INVALID_REFRESH');
    }
    if (entry.used) {
      // 한 번 쓴 토큰이 다시 왔다 → 누군가 복사해 쓰고 있다. 이 계열 전체를 무효화한다.
      this.revokedFamilies.add(entry.familyId);
      throw new AuthError('REFRESH_REUSED');
    }
    entry.used = true;
    const user = this.users.get(entry.userId);
    if (!user) throw new AuthError('INVALID_REFRESH');
    return this.issue(user, entry.familyId);
  }

  logout(refreshToken: string): void {
    const entry = this.refresh.get(sha256(refreshToken));
    if (entry) this.revokedFamilies.add(entry.familyId);
  }

  verify(accessToken: string): AccessClaims {
    return verifyAccessToken(this.config.secret, accessToken, Math.floor(this.now() / 1000));
  }

  private issue(user: User, familyId: string): TokenPair {
    const refreshToken = randomBytes(32).toString('base64url');
    this.refresh.set(sha256(refreshToken), {
      userId: user.id,
      familyId,
      expiresAt: this.now() + this.config.refreshTtlSec * 1000,
      used: false,
    });
    return {
      accessToken: signAccessToken(
        this.config.secret,
        { sub: user.id, name: user.name },
        this.config.accessTtlSec,
        Math.floor(this.now() / 1000),
      ),
      refreshToken,
      expiresIn: this.config.accessTtlSec,
      user,
    };
  }
}
