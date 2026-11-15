/**
 * 주문 멱등 키 저장소.
 *
 * 같은 키로 다시 들어온 요청은 다시 처리하지 않고 처음 결과를 그대로 돌려준다.
 * 같은 키인데 내용이 다르면 거부한다(클라이언트 버그 방지).
 * Redis로 바꿀 때는 begin을 `SET key pending NX PX ttl`, complete를 `SET key result XX PX ttl`로 옮긴다.
 */
export type BeginResult<T> =
  | { state: 'new' }
  | { state: 'pending' }
  | { state: 'done'; result: T }
  | { state: 'conflict' };

export interface IdempotencyStore<T> {
  begin(key: string, fingerprint: string): Promise<BeginResult<T>>;
  complete(key: string, result: T): Promise<void>;
  /** 처리 중 실패 시 키를 풀어 재시도를 허용 */
  abandon(key: string): Promise<void>;
  get(key: string): Promise<{ fingerprint: string; result?: T } | undefined>;
}

interface Entry<T> {
  fingerprint: string;
  result?: T;
  expiresAt: number;
}

export class InMemoryIdempotencyStore<T> implements IdempotencyStore<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private live(key: string): Entry<T> | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async begin(key: string, fingerprint: string): Promise<BeginResult<T>> {
    const existing = this.live(key);
    if (!existing) {
      this.entries.set(key, { fingerprint, expiresAt: this.now() + this.ttlMs });
      return { state: 'new' };
    }
    if (existing.fingerprint !== fingerprint) return { state: 'conflict' };
    if (existing.result === undefined) return { state: 'pending' };
    return { state: 'done', result: existing.result };
  }

  async complete(key: string, result: T): Promise<void> {
    const entry = this.entries.get(key);
    if (entry) entry.result = result;
  }

  async abandon(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry && entry.result === undefined) this.entries.delete(key);
  }

  async get(key: string): Promise<{ fingerprint: string; result?: T } | undefined> {
    return this.live(key);
  }

  /** 만료된 키 정리(주기적으로 호출) */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= now) {
        this.entries.delete(k);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
