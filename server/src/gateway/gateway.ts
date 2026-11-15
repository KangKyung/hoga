import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type { Bus, MessageKind } from '../bus.js';
import type { Config } from '../config.js';
import type { Metrics } from '../metrics.js';
import { clientMessage, type ErrorMessage, type ServerMessage, type SnapshotMessage } from '../protocol.js';

export interface SnapshotProvider {
  has(symbol: string): boolean;
  snapshot(symbol: string): SnapshotMessage;
}

type GatewayConfig = Pick<
  Config,
  | 'WS_HEARTBEAT_MS'
  | 'WS_MAX_PAYLOAD_BYTES'
  | 'WS_MAX_SUBSCRIPTIONS'
  | 'WS_MSG_RATE_PER_SEC'
  | 'WS_SOFT_BUFFER_BYTES'
  | 'WS_HARD_BUFFER_BYTES'
>;

interface Client {
  id: string;
  ws: WebSocket;
  subs: Set<string>;
  /** 송신 버퍼가 밀려 변경분을 건너뛴 종목 → 버퍼가 비면 최신 스냅샷으로 대체 */
  stale: Set<string>;
  alive: boolean;
  tokens: number;
  lastRefill: number;
}

/** 서비스 재시작: 클라이언트는 지터를 둔 백오프로 다시 접속해야 한다 */
export const CLOSE_SERVICE_RESTART = 1012;
/** 송신 버퍼 초과 */
export const CLOSE_TRY_AGAIN_LATER = 1013;

/**
 * 시세 팬아웃 게이트웨이. 상태를 갖지 않아 여러 대로 늘릴 수 있다.
 *
 * 많은 동시 접속을 버티기 위한 장치
 * - 느린 클라이언트: 송신 버퍼가 SOFT를 넘으면 그 종목 변경분을 건너뛰고(stale), 버퍼가 비면
 *   최신 스냅샷 1개만 보낸다(conflation). HARD를 넘으면 1013으로 끊는다.
 * - 죽은 연결: 하트비트 ping 후 다음 주기까지 pong이 없으면 terminate.
 * - 남용 방지: 메시지 크기 제한, 연결당 초당 메시지 수 제한(토큰 버킷), 구독 개수 제한.
 * - 재시작: close()가 모든 연결에 1012를 보내 클라이언트가 흩어져 재접속하게 한다.
 */
export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly bySymbol = new Map<string, Set<Client>>();
  private readonly unsubscribeBus: () => void;
  private readonly heartbeat: NodeJS.Timeout;
  private closing = false;

  constructor(
    server: Server,
    bus: Bus,
    private readonly snapshots: SnapshotProvider,
    private readonly metrics: Metrics,
    private readonly config: GatewayConfig,
    private readonly log: FastifyBaseLogger,
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: config.WS_MAX_PAYLOAD_BYTES });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.unsubscribeBus = bus.subscribeAll((symbol, kind, payload) => this.fanOut(symbol, kind, payload));
    this.heartbeat = setInterval(() => this.checkHeartbeats(), config.WS_HEARTBEAT_MS);
    this.heartbeat.unref();

    metrics.describe('hoga_ws_connections', 'gauge', 'Open WebSocket connections');
    metrics.describe('hoga_ws_messages_sent_total', 'counter', 'Messages sent to clients');
    metrics.describe('hoga_ws_conflated_total', 'counter', 'Deltas skipped for slow clients (replaced by snapshot)');
    metrics.describe('hoga_ws_closed_slow_total', 'counter', 'Connections closed for exceeding buffer limit');
    metrics.describe('hoga_ws_heartbeat_timeouts_total', 'counter', 'Connections terminated by heartbeat');
    metrics.describe('hoga_ws_rejected_messages_total', 'counter', 'Client messages rejected');
    metrics.gauge('hoga_ws_connections', () => this.clients.size);
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  /** 정상 종료: 새 연결을 받지 않고 기존 연결에 1012를 보낸다 */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.heartbeat);
    this.unsubscribeBus();
    for (const client of this.clients) client.ws.close(CLOSE_SERVICE_RESTART, 'service restart');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onConnection(ws: WebSocket): void {
    if (this.closing) {
      ws.close(CLOSE_SERVICE_RESTART, 'service restart');
      return;
    }
    const client: Client = {
      id: randomUUID(),
      ws,
      subs: new Set(),
      stale: new Set(),
      alive: true,
      tokens: this.config.WS_MSG_RATE_PER_SEC,
      lastRefill: Date.now(),
    };
    this.clients.add(client);
    this.log.debug({ client: client.id }, 'ws connected');

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    ws.on('close', () => this.removeClient(client));
    ws.on('error', (err) => this.log.warn({ client: client.id, err }, 'ws error'));
  }

  private removeClient(client: Client): void {
    this.clients.delete(client);
    for (const symbol of client.subs) this.bySymbol.get(symbol)?.delete(client);
    client.subs.clear();
  }

  private takeToken(client: Client): boolean {
    const now = Date.now();
    const rate = this.config.WS_MSG_RATE_PER_SEC;
    client.tokens = Math.min(rate, client.tokens + ((now - client.lastRefill) / 1000) * rate);
    client.lastRefill = now;
    if (client.tokens < 1) return false;
    client.tokens -= 1;
    return true;
  }

  private reject(client: Client, code: ErrorMessage['code'], message: string): void {
    this.metrics.inc('hoga_ws_rejected_messages_total', { code });
    this.sendJson(client, { t: 'error', code, message });
  }

  private onMessage(client: Client, data: RawData, isBinary: boolean): void {
    if (!this.takeToken(client)) {
      this.reject(client, 'RATE_LIMITED', 'too many messages');
      return;
    }
    let parsed: unknown;
    try {
      if (isBinary) throw new Error('binary not supported');
      parsed = JSON.parse(data.toString());
    } catch {
      this.reject(client, 'BAD_MESSAGE', 'invalid JSON');
      return;
    }
    const result = clientMessage.safeParse(parsed);
    if (!result.success) {
      this.reject(client, 'BAD_MESSAGE', result.error.issues[0]?.message ?? 'invalid message');
      return;
    }
    const msg = result.data;
    switch (msg.op) {
      case 'ping':
        this.sendJson(client, { t: 'pong', ts: Date.now() });
        return;
      case 'unsub':
        for (const symbol of msg.symbols) {
          client.subs.delete(symbol);
          client.stale.delete(symbol);
          this.bySymbol.get(symbol)?.delete(client);
        }
        return;
      case 'sub': {
        const unknown = msg.symbols.find((s) => !this.snapshots.has(s));
        if (unknown) {
          this.reject(client, 'UNKNOWN_SYMBOL', `unknown symbol ${unknown}`);
          return;
        }
        const added = msg.symbols.filter((s) => !client.subs.has(s));
        if (client.subs.size + added.length > this.config.WS_MAX_SUBSCRIPTIONS) {
          this.reject(client, 'TOO_MANY_SUBSCRIPTIONS', `max ${this.config.WS_MAX_SUBSCRIPTIONS} symbols`);
          return;
        }
        for (const symbol of added) {
          client.subs.add(symbol);
          let set = this.bySymbol.get(symbol);
          if (!set) this.bySymbol.set(symbol, (set = new Set()));
          set.add(client);
          // 구독 직후 스냅샷. 한 이벤트 루프 안이라 이후 변경분은 반드시 이 seq 다음부터 온다.
          this.sendJson(client, this.snapshots.snapshot(symbol));
        }
        this.sendJson(client, { t: 'subscribed', symbols: [...client.subs] });
        return;
      }
    }
  }

  private fanOut(symbol: string, kind: MessageKind, payload: string): void {
    const subscribers = this.bySymbol.get(symbol);
    if (!subscribers) return;
    for (const client of subscribers) this.deliver(client, symbol, kind, payload);
  }

  private deliver(client: Client, symbol: string, kind: MessageKind, payload: string): void {
    const { ws } = client;
    if (ws.readyState !== WebSocket.OPEN) return;
    const buffered = ws.bufferedAmount;

    if (buffered > this.config.WS_HARD_BUFFER_BYTES) {
      this.metrics.inc('hoga_ws_closed_slow_total');
      ws.close(CLOSE_TRY_AGAIN_LATER, 'client too slow');
      return;
    }

    if (kind === 'book') {
      if (client.stale.has(symbol)) {
        // 버퍼가 충분히 비면 쌓인 변경분 대신 최신 스냅샷 하나로 따라잡게 한다.
        if (buffered < this.config.WS_SOFT_BUFFER_BYTES / 2) {
          client.stale.delete(symbol);
          this.sendJson(client, this.snapshots.snapshot(symbol));
        } else {
          this.metrics.inc('hoga_ws_conflated_total');
        }
        return;
      }
      if (buffered > this.config.WS_SOFT_BUFFER_BYTES) {
        client.stale.add(symbol);
        this.metrics.inc('hoga_ws_conflated_total');
        return;
      }
    } else if (buffered > this.config.WS_SOFT_BUFFER_BYTES) {
      // 체결 알림은 정보용이라 밀리면 그냥 버린다.
      return;
    }

    ws.send(payload);
    this.metrics.inc('hoga_ws_messages_sent_total');
  }

  private sendJson(client: Client, message: ServerMessage): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(JSON.stringify(message));
    this.metrics.inc('hoga_ws_messages_sent_total');
  }

  private checkHeartbeats(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        this.metrics.inc('hoga_ws_heartbeat_timeouts_total');
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }
}
