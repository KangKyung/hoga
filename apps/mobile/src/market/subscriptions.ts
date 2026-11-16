import {AppState, type AppStateStatus} from 'react-native';
import {useEffect, useState} from 'react';

import {hogaCore} from '../native/hogaCore';

/**
 * 시세 구독 관리(화면에 보이는 종목만).
 *
 * 종목이 120개라 전부 구독하면 서버·네트워크·배터리를 낭비한다(관심종목 화면에 보이는 건 15개 남짓).
 * - 화면이 필요한 종목을 acquire/release(참조 수). 같은 종목을 여러 화면이 써도 한 번만 구독.
 * - 구독 해제는 잠깐(UNSUB_DELAY_MS) 미룬다: 스크롤로 잠깐 벗어났다 돌아오는 종목이 스냅샷을 다시 받지 않게.
 * - 변경은 모아서(FLUSH_MS) 보낸다: 스크롤 중 WS 메시지 폭주를 막는다(서버는 연결당 초당 메시지 수 제한).
 * - 상한(MAX_ACTIVE, 서버 제한 40보다 작게): 넘으면 쓰지 않는 종목부터 즉시 해제, 그래도 넘으면 나중 것은 보류.
 * - 백그라운드 BACKGROUND_GRACE_MS가 지나면 소켓을 닫고, 돌아오면 다시 연결해 지금 필요한 종목만 구독한다.
 */
export const UNSUB_DELAY_MS = 1_500;
export const FLUSH_MS = 120;
export const MAX_ACTIVE = 36;
export const BACKGROUND_GRACE_MS = 15_000;

export interface SubscriptionDeps {
  subscribe(codes: string[]): void;
  unsubscribe(codes: string[]): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export class SubscriptionManager {
  private readonly refs = new Map<string, number>();
  /** 참조가 0이 된 시각 */
  private readonly releasedAt = new Map<string, number>();
  /** 서버(C++ 클라이언트)에 실제로 구독한 종목 */
  private readonly active = new Set<string>();
  private timer: unknown;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: SubscriptionDeps) {}

  acquire(codes: readonly string[]): () => void {
    for (const c of codes) {
      this.refs.set(c, (this.refs.get(c) ?? 0) + 1);
      this.releasedAt.delete(c);
    }
    this.schedule(0);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const c of codes) {
        const n = (this.refs.get(c) ?? 0) - 1;
        if (n > 0) {
          this.refs.set(c, n);
        } else {
          this.refs.delete(c);
          this.releasedAt.set(c, this.deps.now());
        }
      }
      this.schedule(0);
    };
  }

  activeCount(): number {
    return this.active.size;
  }

  isActive(code: string): boolean {
    return this.active.has(code);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 다시 연결한 뒤(새 C++ 클라이언트): 지금 필요한 종목을 처음부터 구독 */
  resubscribe(): void {
    this.active.clear();
    for (const [c] of this.releasedAt) if (!this.refs.has(c)) this.releasedAt.delete(c);
    this.flush();
  }

  /** 밀린 작업을 바로 처리(테스트용) */
  flush(): void {
    this.timer = undefined;
    const now = this.deps.now();
    const wanted = [...this.refs.keys()];
    const add = wanted.filter(c => !this.active.has(c));

    // 쓰지 않는 종목: 지연이 지났거나, 상한을 넘으면 오래된 것부터 바로 해제
    const idle = [...this.active]
      .filter(c => !this.refs.has(c))
      .sort((a, b) => (this.releasedAt.get(a) ?? 0) - (this.releasedAt.get(b) ?? 0));
    const remove: string[] = [];
    let projected = this.active.size + add.length;
    for (const c of idle) {
      const expired = now - (this.releasedAt.get(c) ?? 0) >= UNSUB_DELAY_MS;
      if (expired || projected > MAX_ACTIVE) {
        remove.push(c);
        projected -= 1;
      }
    }
    if (remove.length) {
      for (const c of remove) {
        this.active.delete(c);
        this.releasedAt.delete(c);
      }
      this.deps.unsubscribe(remove);
    }
    // 그래도 넘으면 나중 것은 보류(자리가 나면 다음 flush에서)
    const room = Math.max(0, MAX_ACTIVE - this.active.size);
    const toAdd = add.slice(0, room);
    for (let i = 0; i < toAdd.length; i += 50) this.deps.subscribe(toAdd.slice(i, i + 50));
    for (const c of toAdd) this.active.add(c);

    const waiting = idle.length > remove.length || add.length > toAdd.length;
    if (waiting) this.schedule(UNSUB_DELAY_MS / 3);
    if (remove.length || toAdd.length) for (const l of this.listeners) l();
  }

  private schedule(extra: number): void {
    if (this.timer !== undefined) return;
    this.timer = this.deps.setTimer(() => this.flush(), FLUSH_MS + extra);
  }
}

export const subscriptions = new SubscriptionManager({
  subscribe: codes => hogaCore.subscribe(codes),
  unsubscribe: codes => hogaCore.unsubscribe(codes),
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
});

/** 화면이 보는 동안 구독. codes 내용이 바뀔 때만 다시 잡는다 */
export function useSubscription(codes: readonly string[]): void {
  const key = codes.join(',');
  useEffect(() => {
    if (!key) return;
    return subscriptions.acquire(key.split(','));
  }, [key]);
}

export function useActiveCount(): number {
  const [n, setN] = useState(subscriptions.activeCount());
  useEffect(() => subscriptions.onChange(() => setN(subscriptions.activeCount())), []);
  return n;
}

/**
 * 앱 생명주기: 백그라운드가 길어지면 소켓을 닫고(배터리·데이터·서버 연결 수), 돌아오면 다시 연결한다.
 * 짧게 나갔다 오는 경우(알림 확인 등)는 연결을 유지한다.
 */
export function startMarketLifecycle(connect: () => void, disconnect: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;
  connect();
  const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'background') {
      clearTimeout(timer);
      timer = setTimeout(() => {
        suspended = true;
        disconnect();
      }, BACKGROUND_GRACE_MS);
    } else if (state === 'active') {
      clearTimeout(timer);
      if (suspended) {
        suspended = false;
        connect();
        subscriptions.resubscribe();
      }
    }
  });
  return () => {
    clearTimeout(timer);
    sub.remove();
    disconnect();
  };
}
