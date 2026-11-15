import {useSyncExternalStore} from 'react';

import {HttpError, request, setTokenSource} from '../api/http';
import {track} from '../analytics/analytics';
import {t, type MessageKey} from '../i18n';
import {hogaCore} from '../native/hogaCore';
import {secureStore, secureStoreErrorCode} from '../native/security';

const REFRESH_KEY = 'auth.refreshToken';
const LOCK_KEY = 'auth.appLock';
const LOCK_ENABLED_KEY = 'auth.lockEnabled';

export interface User {
  id: string;
  username: string;
  name: string;
}

/** message는 번역 키. 화면이 그릴 때 현재 언어로 바꾼다(언어를 바꿔도 안내가 따라 바뀌게) */
export type SessionState =
  | {status: 'loading'}
  | {status: 'signedOut'; message?: MessageKey}
  | {status: 'locked'; message?: MessageKey}
  | {status: 'signedIn'; user: User};

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
}

/**
 * 로그인 세션.
 *
 * - 리프레시 토큰: 보안 저장소(기기 밖으로 복제되지 않는 Keychain·Keystore)
 * - 액세스 토큰: 메모리에만. 만료 1분 전에 미리 갱신하고, 시세 서버(C++ MarketClient)에도 넘긴다.
 * - 리프레시 토큰은 쓸 때마다 바뀐다(서버 회전). 새 토큰을 **먼저 저장한 뒤** 사용한다.
 *   저장 전에 앱이 죽어 이전 토큰을 다시 내밀면 서버가 탈취로 보고 세션을 끊기 때문이다.
 * - 생체 잠금: 앱을 열 때 생체 인증이 걸린 값(LOCK_KEY)을 읽어야만 세션을 복원한다.
 *   매 회전마다 생체 인증을 요구하지 않도록 리프레시 토큰 자체가 아니라 잠금 값을 생체로 보호한다.
 */
class SessionManager {
  private state: SessionState = {status: 'loading'};
  private listeners = new Set<() => void>();
  private access: string | null = null;
  private refreshing: Promise<string | null> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(state: SessionState) {
    this.state = state;
    this.listeners.forEach(l => l());
  }

  /** 앱 시작 시 */
  async restore() {
    try {
      if ((await secureStore.get(LOCK_ENABLED_KEY)) === '1') {
        this.set({status: 'locked'});
        return;
      }
      await this.resume();
    } catch {
      this.set({status: 'signedOut'});
    }
  }

  /** 생체 인증으로 잠금 해제 */
  async unlock() {
    try {
      const lock = await secureStore.get(LOCK_KEY, t('session.unlockPrompt'));
      if (!lock) throw new Error('missing lock');
      await this.resume();
    } catch (e) {
      const code = secureStoreErrorCode(e);
      if (code === 'E_CANCELLED') {
        this.set({status: 'locked'});
      } else if (code === 'E_INVALIDATED') {
        await this.clear();
        this.set({status: 'signedOut', message: 'session.biometryChanged'});
      } else {
        this.set({status: 'locked', message: 'session.unlockFailed'});
      }
    }
  }

  async login(username: string, password: string, enableLock: boolean) {
    try {
      const {data} = await request<TokenResponse>('/auth/login', {
        method: 'POST',
        body: {username, password},
      });
      await this.accept(data);
      track('login', {method: 'password', lock_enabled: enableLock});
      if (enableLock) {
        await secureStore.set(LOCK_KEY, hogaCore.randomId(), {
          biometric: true,
          prompt: t('session.enableLockPrompt'),
        });
        await secureStore.set(LOCK_ENABLED_KEY, '1');
      }
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) {
        this.set({status: 'signedOut', message: 'session.tooMany'});
      } else if (e instanceof HttpError && e.status === 401) {
        this.set({status: 'signedOut', message: 'session.badCredentials'});
      } else if (e instanceof HttpError && e.status < 500) {
        this.set({status: 'signedOut', message: 'session.badInput'});
      } else if (secureStoreErrorCode(e)) {
        // 로그인은 됐지만 생체 잠금 설정을 취소·실패 → 잠금 없이 계속
        return;
      } else {
        this.set({status: 'signedOut', message: 'session.unreachable'});
      }
    }
  }

  async logout() {
    const refreshToken = await secureStore.get(REFRESH_KEY).catch(() => null);
    if (refreshToken) {
      await request('/auth/logout', {
        method: 'POST',
        body: {refreshToken},
      }).catch(() => {});
    }
    await this.clear();
    this.set({status: 'signedOut'});
  }

  /** 예약된 토큰 갱신 타이머 정리(테스트·앱 종료 시) */
  dispose() {
    clearTimeout(this.refreshTimer);
  }

  /** TokenSource: 동시에 여러 요청이 401을 받아도 갱신은 한 번만 */
  readonly tokens = {
    accessToken: () => this.access,
    refresh: () => {
      if (!this.refreshing) {
        this.refreshing = this.rotate().finally(() => {
          this.refreshing = null;
        });
      }
      return this.refreshing;
    },
  };

  private async resume() {
    const token = await this.rotate();
    // rotate()가 이미 안내 문구와 함께 로그아웃 상태로 바꿨다면 덮어쓰지 않는다
    if (!token && (this.state.status === 'loading' || this.state.status === 'locked')) {
      this.set({status: 'signedOut'});
    }
  }

  private async rotate(): Promise<string | null> {
    const refreshToken = await secureStore.get(REFRESH_KEY);
    if (!refreshToken) return null;
    try {
      const {data} = await request<TokenResponse>('/auth/refresh', {
        method: 'POST',
        body: {refreshToken},
      });
      await this.accept(data);
      return data.accessToken;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        await this.clear();
        this.set({status: 'signedOut', message: 'session.expired'});
      }
      return null;
    }
  }

  private async accept(data: TokenResponse) {
    await secureStore.set(REFRESH_KEY, data.refreshToken); // 먼저 저장
    this.access = data.accessToken;
    hogaCore.setAuthToken(data.accessToken);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.tokens.refresh(), Math.max(10, data.expiresIn - 60) * 1000);
    this.set({status: 'signedIn', user: data.user});
  }

  private async clear() {
    clearTimeout(this.refreshTimer);
    this.access = null;
    hogaCore.setAuthToken('');
    await Promise.all([REFRESH_KEY, LOCK_KEY, LOCK_ENABLED_KEY].map(k => secureStore.remove(k).catch(() => {})));
  }
}

export const session = new SessionManager();
setTokenSource(session.tokens);

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.getState);
}
