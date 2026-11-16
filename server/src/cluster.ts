/**
 * 여러 프로세스로 나눴을 때(ROLE=market / gateway) market이 gateway들을 보는 창.
 * - gateway는 1초마다 자기 연결 수·보낸 메시지 수를 Redis에 남긴다(3초 TTL → 죽은 gateway는 사라짐)
 * - market의 관리 API는 그 합을 보여 주고, "연결 끊기"는 관리 채널로 모든 gateway에 알린다
 */
import type { Redis } from 'ioredis';

import type { Bus } from './bus.js';

const KEY = 'hoga:gw:';

/** 관리 API가 쓰는 gateway 제어. 한 프로세스면 Gateway 자신, 여러 프로세스면 ClusterGateways */
export interface GatewayControl {
  connectionCount(): number | Promise<number>;
  messagesSent?(): Promise<number>;
  /** 끊은 수. 다른 프로세스에 알리기만 했으면 null */
  disconnectAll(): number | null;
  gateways?(): Promise<GatewayStat[]>;
}

export interface GatewayStat {
  id: string;
  connections: number;
  sent: number;
}

export function reportGatewayStats(redis: Redis, id: string, read: () => { connections: number; sent: number }): () => void {
  const timer = setInterval(() => {
    const { connections, sent } = read();
    void redis
      .multi()
      .hset(KEY + id, { connections: String(connections), sent: String(sent) })
      .pexpire(KEY + id, 3_000)
      .exec()
      .catch(() => {});
  }, 1_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    void redis.del(KEY + id).catch(() => {});
  };
}

export class ClusterGateways implements GatewayControl {
  constructor(
    private readonly redis: Redis,
    private readonly bus: Bus,
  ) {}

  async gateways(): Promise<GatewayStat[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${KEY}*`, 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    const rows = await Promise.all(keys.map((k) => this.redis.hgetall(k)));
    return rows
      .map((h, i) => ({ id: keys[i]!.slice(KEY.length), connections: Number(h.connections ?? 0), sent: Number(h.sent ?? 0) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async connectionCount(): Promise<number> {
    return (await this.gateways()).reduce((a, g) => a + g.connections, 0);
  }

  async messagesSent(): Promise<number> {
    return (await this.gateways()).reduce((a, g) => a + g.sent, 0);
  }

  disconnectAll(): null {
    this.bus.publishAdmin('disconnect');
    return null;
  }
}
