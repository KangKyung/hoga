/**
 * 리프레시 토큰 저장소. 서버에는 토큰의 해시만 둔다.
 * - 메모리: 한 프로세스(개발·테스트)
 * - Redis: 서버를 재시작하거나 여러 대로 늘려도 로그인이 유지된다(src/redis/refreshStore.ts)
 */
export interface RefreshEntry {
  userId: string;
  familyId: string;
  expiresAt: number;
}

export type ConsumeResult = { state: 'ok'; entry: RefreshEntry } | { state: 'missing' } | { state: 'reused'; entry: RefreshEntry };

export interface RefreshStore {
  save(hash: string, entry: RefreshEntry): Promise<void>;
  /** 한 번만 성공한다. 두 번째부터는 reused(탈취 신호). 원자적이어야 한다 */
  consume(hash: string): Promise<ConsumeResult>;
  peek(hash: string): Promise<RefreshEntry | undefined>;
  revokeFamily(familyId: string, ttlMs: number): Promise<void>;
  isRevoked(familyId: string): Promise<boolean>;
}

export class InMemoryRefreshStore implements RefreshStore {
  private readonly entries = new Map<string, RefreshEntry & { used: boolean }>();
  private readonly revoked = new Set<string>();

  async save(hash: string, entry: RefreshEntry): Promise<void> {
    this.entries.set(hash, { ...entry, used: false });
  }

  async consume(hash: string): Promise<ConsumeResult> {
    const e = this.entries.get(hash);
    if (!e) return { state: 'missing' };
    const { used, ...entry } = e;
    if (used) return { state: 'reused', entry };
    e.used = true;
    return { state: 'ok', entry };
  }

  async peek(hash: string): Promise<RefreshEntry | undefined> {
    const e = this.entries.get(hash);
    return e && { userId: e.userId, familyId: e.familyId, expiresAt: e.expiresAt };
  }

  async revokeFamily(familyId: string): Promise<void> {
    this.revoked.add(familyId);
  }

  async isRevoked(familyId: string): Promise<boolean> {
    return this.revoked.has(familyId);
  }
}
