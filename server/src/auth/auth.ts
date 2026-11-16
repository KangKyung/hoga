import { createHash, randomBytes } from 'node:crypto';

import { signAccessToken, verifyAccessToken, type AccessClaims } from './jwt.js';
import { InMemoryRefreshStore, type RefreshStore } from './refreshStore.js';
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
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly users: UserStore,
    private readonly config: AuthConfig,
    private readonly now: () => number = Date.now,
    private readonly refresh: RefreshStore = new InMemoryRefreshStore(),
  ) {}

  async login(username: string, password: string): Promise<TokenPair> {
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

  async rotate(refreshToken: string): Promise<TokenPair> {
    // 사용 표시는 저장소가 원자적으로 한다(동시에 두 요청이 와도 하나만 성공)
    const result = await this.refresh.consume(sha256(refreshToken));
    if (result.state === 'missing') throw new AuthError('INVALID_REFRESH');
    const { entry } = result;
    if (entry.expiresAt <= this.now() || (await this.refresh.isRevoked(entry.familyId))) {
      throw new AuthError('INVALID_REFRESH');
    }
    if (result.state === 'reused') {
      // 한 번 쓴 토큰이 다시 왔다 → 누군가 복사해 쓰고 있다. 이 계열 전체를 무효화한다.
      await this.refresh.revokeFamily(entry.familyId, this.config.refreshTtlSec * 1000);
      throw new AuthError('REFRESH_REUSED');
    }
    const user = this.users.get(entry.userId);
    if (!user) throw new AuthError('INVALID_REFRESH');
    return this.issue(user, entry.familyId);
  }

  async logout(refreshToken: string): Promise<void> {
    const entry = await this.refresh.peek(sha256(refreshToken));
    if (entry) await this.refresh.revokeFamily(entry.familyId, this.config.refreshTtlSec * 1000);
  }

  verify(accessToken: string): AccessClaims {
    return verifyAccessToken(this.config.secret, accessToken, Math.floor(this.now() / 1000));
  }

  private async issue(user: User, familyId: string): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url');
    await this.refresh.save(sha256(refreshToken), {
      userId: user.id,
      familyId,
      expiresAt: this.now() + this.config.refreshTtlSec * 1000,
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
