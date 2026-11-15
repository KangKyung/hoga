import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { registerAdminRoutes, type FaultState } from './api/admin.js';
import { registerAuthRoutes } from './api/auth.js';
import { registerOrderRoutes, type OrderRecord } from './api/orders.js';
import { registerWebRoutes } from './api/web.js';
import { AuthService } from './auth/auth.js';
import { UserStore } from './auth/users.js';
import { InMemoryBus, type Bus } from './bus.js';
import type { Config } from './config.js';
import { coreVersion } from './core.js';
import { Gateway } from './gateway/gateway.js';
import { InMemoryIdempotencyStore } from './idempotency.js';
import { Market, type MarketOptions } from './market/market.js';
import { Metrics } from './metrics.js';
import { OrderTracker } from './orders/tracker.js';
import { SYMBOL_PATTERN } from './protocol.js';

export interface HogaServer {
  app: FastifyInstance;
  market: Market;
  gateway: Gateway;
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

export function createServer(config: Config, options: CreateServerOptions = {}): HogaServer {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, bodyLimit: 4 * 1024 });
  const log = app.log;
  const metrics = new Metrics();
  const bus: Bus = new InMemoryBus();
  const market = new Market(bus, metrics, {
    dropSeqRate: config.FAULT_DROP_SEQ_RATE,
    historyMinutes: config.HISTORY_MINUTES,
    ...options.market,
  });
  const store = new InMemoryIdempotencyStore<OrderRecord>(config.IDEMPOTENCY_TTL_MS);
  const tracker = new OrderTracker(market, bus);
  const auth = new AuthService(new UserStore(), {
    secret: config.JWT_SECRET,
    accessTtlSec: config.ACCESS_TOKEN_TTL_SEC,
    refreshTtlSec: config.REFRESH_TOKEN_TTL_SEC,
    maxFailuresPerMinute: config.LOGIN_MAX_FAILURES_PER_MIN,
  });
  const gateway = new Gateway(app.server, bus, market, metrics, config, log, (token) => {
    try {
      return auth.verify(token).sub;
    } catch {
      return undefined;
    }
  });
  const startedAt = Date.now();
  const faults: FaultState = { orderDelayMs: config.FAULT_ORDER_DELAY_MS };

  app.get('/healthz', async () => ({ ok: true, coreVersion: coreVersion(), uptimeMs: Date.now() - startedAt }));
  app.get('/readyz', async () => ({ ready: true, bus: 'memory', idempotency: 'memory' }));
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
  registerOrderRoutes(app, {
    market,
    store,
    tracker,
    auth,
    metrics,
    responseDelayMs: () => faults.orderDelayMs,
  });
  registerWebRoutes(app, { market, config });
  registerAdminRoutes(app, { token: config.ADMIN_TOKEN, market, gateway, metrics, faults });

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
      await gateway.close();
      await app.close();
      await bus.close();
    },
  };
}
