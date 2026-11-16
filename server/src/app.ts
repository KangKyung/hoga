import { monitorEventLoopDelay } from 'node:perf_hooks';

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { registerAdminRoutes, type FaultState } from './api/admin.js';
import { registerAuthRoutes } from './api/auth.js';
import { registerOrderRoutes, type OrderRecord } from './api/orders.js';
import { registerOtpRoutes } from './api/otp.js';
import { registerWebRoutes } from './api/web.js';
import { AuthService } from './auth/auth.js';
import { InMemoryOtpStore, OtpService } from './auth/otp.js';
import { InMemoryRefreshStore } from './auth/refreshStore.js';
import { UserStore } from './auth/users.js';
import { InMemoryBus, type Bus } from './bus.js';
import { ClusterGateways, reportGatewayStats, type GatewayControl } from './cluster.js';
import type { Config } from './config.js';
import { coreVersion } from './core.js';
import { Gateway } from './gateway/gateway.js';
import { BookReplica } from './gateway/replica.js';
import { InMemoryIdempotencyStore } from './idempotency.js';
import { Market, type MarketOptions } from './market/market.js';
import { Metrics } from './metrics.js';
import { OrderTracker } from './orders/tracker.js';
import { SYMBOL_PATTERN } from './protocol.js';
import { RedisBus } from './redis/bus.js';
import { RedisIdempotencyStore } from './redis/idempotency.js';
import { RedisOtpStore } from './redis/otpStore.js';
import { RedisRefreshStore } from './redis/refreshStore.js';

export interface HogaServer {
  app: FastifyInstance;
  market: Market;
  /** ROLE=market이면 없다(WebSocket은 gateway 프로세스가 맡음) */
  gateway?: Gateway;
  metrics: Metrics;
  log: FastifyBaseLogger;
  /** listen 후 실제 주소(테스트용) */
  url(): string;
  start(): Promise<void>;
  /** 정상 종료: WS 1012 → HTTP 종료 */
  stop(): Promise<void>;
}

export interface CreateServerOptions {
  market?: MarketOptions;
}

function authConfig(config: Config) {
  return {
    secret: config.JWT_SECRET,
    accessTtlSec: config.ACCESS_TOKEN_TTL_SEC,
    refreshTtlSec: config.REFRESH_TOKEN_TTL_SEC,
    maxFailuresPerMinute: config.LOGIN_MAX_FAILURES_PER_MIN,
  };
}

/** ROLE=all | market. gateway는 createGatewayServer */
export function createServer(config: Config, options: CreateServerOptions = {}): HogaServer {
  if (config.ROLE === 'gateway') throw new Error('use createGatewayServer for ROLE=gateway');
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, bodyLimit: 4 * 1024 });
  const log = app.log;
  const metrics = new Metrics();
  const redisBus = config.REDIS_URL ? new RedisBus(config.REDIS_URL) : undefined;
  const bus: Bus = redisBus ?? new InMemoryBus();
  const market = new Market(bus, metrics, {
    dropSeqRate: config.FAULT_DROP_SEQ_RATE,
    historyMinutes: config.HISTORY_MINUTES,
    ...options.market,
  });
  const store = redisBus
    ? new RedisIdempotencyStore<OrderRecord>(redisBus.client, config.IDEMPOTENCY_TTL_MS)
    : new InMemoryIdempotencyStore<OrderRecord>(config.IDEMPOTENCY_TTL_MS);
  const tracker = new OrderTracker(market, bus);
  const auth = new AuthService(
    new UserStore(),
    authConfig(config),
    Date.now,
    redisBus ? new RedisRefreshStore(redisBus.client) : new InMemoryRefreshStore(),
  );
  const otp = new OtpService(
    redisBus ? new RedisOtpStore(redisBus.client) : new InMemoryOtpStore(),
    config.OTP_ENC_KEY,
    config.JWT_SECRET,
  );
  // ROLE=market: WebSocket은 gateway 프로세스들이 맡는다
  const gateway =
    config.ROLE === 'all'
      ? new Gateway(app.server, bus, market, metrics, config, log, (token) => {
          try {
            return auth.verify(token).sub;
          } catch {
            return undefined;
          }
        })
      : undefined;
  const gatewayControl: GatewayControl = gateway
    ? { connectionCount: () => gateway.connectionCount, disconnectAll: () => gateway.disconnectAll() }
    : new ClusterGateways(redisBus!.client, bus);
  const startedAt = Date.now();
  const faults: FaultState = { orderDelayMs: config.FAULT_ORDER_DELAY_MS };

  app.get('/healthz', async () => ({ ok: true, coreVersion: coreVersion(), uptimeMs: Date.now() - startedAt }));
  const backend = redisBus ? 'redis' : 'memory';
  app.get('/readyz', async () => ({ ready: true, role: config.ROLE, bus: backend, idempotency: backend, refreshTokens: backend }));
  app.get('/metrics', async (_request, reply) =>
    reply.type('text/plain; version=0.0.4').send(metrics.render()),
  );
  app.get('/symbols', async () => market.list());

  app.get<{ Params: { symbol: string }; Querystring: { depth?: string } }>(
    '/book/:symbol',
    async (request, reply) => {
      const { symbol } = request.params;
      if (!SYMBOL_PATTERN.test(symbol) || !market.has(symbol)) {
        return reply.code(404).send({ error: 'UNKNOWN_SYMBOL' });
      }
      const depth = Math.min(50, Math.max(1, Number(request.query.depth ?? 20) || 20));
      return market.snapshot(symbol, depth);
    },
  );

  /** 차트용 봉. interval: 1m(기본) | 5m | 15m, 오래된 것부터 [start, open, high, low, close, volume] */
  app.get<{ Params: { symbol: string }; Querystring: { limit?: string; interval?: string } }>(
    '/candles/:symbol',
    async (request, reply) => {
      const { symbol } = request.params;
      if (!SYMBOL_PATTERN.test(symbol) || !market.has(symbol)) {
        return reply.code(404).send({ error: 'UNKNOWN_SYMBOL' });
      }
      const minutes = { '1m': 1, '5m': 5, '15m': 15 }[request.query.interval ?? '1m'];
      if (!minutes) return reply.code(400).send({ error: 'BAD_INTERVAL' });
      const limit = Math.min(2_000, Math.max(1, Number(request.query.limit ?? 300) || 300));
      const interval = minutes * 60_000;
      return { interval, bars: market.candles(symbol, limit, minutes === 1 ? 0 : interval) };
    },
  );

  registerAuthRoutes(app, auth);
  registerOtpRoutes(app, auth, otp);
  registerOrderRoutes(app, {
    market,
    store,
    tracker,
    auth,
    otp,
    metrics,
    responseDelayMs: () => faults.orderDelayMs,
  });
  registerWebRoutes(app, { market, config });
  registerAdminRoutes(app, { token: config.ADMIN_TOKEN, market, gateway: gatewayControl, metrics, faults, otp });

  let stopSimulator = () => {};
  const sweeper = setInterval(() => store.sweep(), 60_000);
  sweeper.unref();

  return {
    app,
    market,
    gateway,
    metrics,
    log,
    url() {
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('server not listening');
      return `http://127.0.0.1:${address.port}`;
    },
    async start() {
      await app.listen({ host: config.HOST, port: config.PORT });
      stopSimulator = market.startSimulator(config.SIM_INTERVAL_MS);
    },
    async stop() {
      stopSimulator();
      clearInterval(sweeper);
      tracker.close();
      await gateway?.close();
      await app.close();
      await bus.close();
    },
  };
}

export interface GatewayServer {
  app: FastifyInstance;
  gateway: Gateway;
  replica: BookReplica;
  metrics: Metrics;
  log: FastifyBaseLogger;
  url(): string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * ROLE=gateway: WebSocket 팬아웃만. 상태 없음(복제 장부는 언제든 다시 받을 수 있다) → 여러 대로 늘리고 아무거나 죽여도 된다.
 * 시세·내 주문 알림·관리 명령은 Redis에서 받고, 토큰은 같은 비밀 키로 직접 검증한다(인증 서버에 묻지 않음).
 */
export function createGatewayServer(config: Config): GatewayServer {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, bodyLimit: 1024 });
  const log = app.log;
  const metrics = new Metrics();
  const bus = new RedisBus(config.REDIS_URL!);
  const loopLag = monitorEventLoopDelay({ resolution: 10 });
  loopLag.enable();
  const replica = new BookReplica(config.MARKET_URL);
  // 복제 장부를 gateway보다 먼저 구독해, 같은 메시지에서 장부가 먼저 바뀐 뒤 클라이언트로 나간다
  bus.subscribeAll((symbol, kind, payload) => {
    if (kind === 'book') replica.onBook(symbol, payload);
  });
  bus.onResubscribe(() => replica.resyncAll());
  const auth = new AuthService(new UserStore(), authConfig(config));
  const gateway = new Gateway(app.server, bus, replica, metrics, config, log, (token) => {
    try {
      return auth.verify(token).sub;
    } catch {
      return undefined;
    }
  });
  bus.subscribeAdmin((command) => {
    if (command === 'disconnect') log.warn({ closed: gateway.disconnectAll() }, 'admin: disconnected all clients');
  });
  let stopReport = () => {};
  let id = config.GATEWAY_ID ?? '';

  app.get('/healthz', async () => ({
    ok: true,
    role: 'gateway',
    id,
    coreVersion: coreVersion(),
    connections: gateway.connectionCount,
    busLagMs: replica.busLag(),
    eventLoopLagMs: Math.round(loopLag.mean / 1e6),
  }));
  app.get('/readyz', async (_request, reply) => {
    const symbols = ['000001', '000002', '000003', '000004', '000005'].filter((s) => replica.has(s));
    const ready = symbols.length > 0 && symbols.every((s) => replica.isLive(s));
    return reply.code(ready ? 200 : 503).send({ ready, role: 'gateway', id, connections: gateway.connectionCount });
  });
  app.get('/metrics', async (_request, reply) => reply.type('text/plain; version=0.0.4').send(metrics.render()));

  return {
    app,
    gateway,
    replica,
    metrics,
    log,
    url() {
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('server not listening');
      return `http://127.0.0.1:${address.port}`;
    },
    async start() {
      await bus.ready();
      await replica.start();
      await app.listen({ host: config.HOST, port: config.PORT });
      const address = app.server.address();
      if (!id) id = `gw-${address && typeof address !== 'string' ? address.port : config.PORT}`;
      stopReport = reportGatewayStats(bus.client, id, () => ({
        connections: gateway.connectionCount,
        sent: metrics.sum('hoga_ws_messages_sent_total'),
      }));
    },
    async stop() {
      stopReport();
      await gateway.close();
      await app.close();
      await bus.close();
    },
  };
}
