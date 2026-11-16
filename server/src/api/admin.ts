import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { OtpService } from '../auth/otp.js';
import type { GatewayControl } from '../cluster.js';
import type { Market } from '../market/market.js';
import type { Metrics } from '../metrics.js';

/** 관리 콘솔이 바꿀 수 있는 장애 주입 값 */
export interface FaultState {
  orderDelayMs: number;
}

export interface AdminDeps {
  token: string;
  market: Market;
  /** 한 프로세스면 Gateway, 여러 프로세스면 Redis로 gateway들을 보는 ClusterGateways */
  gateway: GatewayControl;
  metrics: Metrics;
  faults: FaultState;
  /** 고객센터 기능: OTP 분실 시 초기화(본인 확인은 운영 절차로) */
  otp?: OtpService;
}

const faultsBody = z
  .object({
    dropSeqRate: z.number().min(0).max(0.5).optional(),
    orderDelayMs: z.number().int().min(0).max(30_000).optional(),
    simIntervalMs: z.number().int().min(0).max(5_000).optional(),
    /** 주기마다 종목별 모의 주문 횟수(부하 실험용) */
    simBurst: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const volatilityBody = z
  .object({
    multiplier: z.number().min(0.2).max(10),
    symbol: z.string().regex(/^\d{6}$/).optional(),
  })
  .strict();

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 관리 콘솔 API(/admin/api). 모의 거래소의 장애를 켜고 끄며 앱이 어떻게 복구하는지 시연한다.
 * 토큰은 x-admin-token 헤더로만 받는다(URL에 넣지 않아 로그·Referer에 남지 않게).
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { market, gateway, metrics, faults } = deps;
  metrics.describe('hoga_admin_actions_total', 'counter', 'Admin console actions');

  app.register(
    async (scope) => {
      scope.addHook('onRequest', async (request, reply) => {
        if (!sameToken(request.headers['x-admin-token'], deps.token)) {
          return reply.code(401).send({ error: 'UNAUTHORIZED' });
        }
      });

      /** 대시보드: 콘솔이 1초마다 읽어 초당 값은 직전 값과의 차이로 계산한다 */
      scope.get('/state', async () => ({
        ts: Date.now(),
        gateways: gateway.gateways ? await gateway.gateways() : undefined,
        faults: { ...market.faults, orderDelayMs: faults.orderDelayMs },
        symbols: market.list().map((s) => ({
          code: s.code,
          name: s.name,
          lastPrice: s.lastPrice,
          basePrice: s.basePrice,
          volatility: market.volatility(s.code),
        })),
        counters: {
          connections: await gateway.connectionCount(),
          messagesSent: gateway.messagesSent ? await gateway.messagesSent() : metrics.sum('hoga_ws_messages_sent_total'),
          deltas: metrics.sum('hoga_market_deltas_total'),
          deltasDropped: metrics.sum('hoga_market_deltas_dropped_total'),
          trades: metrics.sum('hoga_market_trades_total'),
          conflated: metrics.sum('hoga_ws_conflated_total'),
          closedSlow: metrics.sum('hoga_ws_closed_slow_total'),
          heartbeatTimeouts: metrics.sum('hoga_ws_heartbeat_timeouts_total'),
          orders: metrics.sum('hoga_orders_total'),
          ordersReplayed: metrics.sum('hoga_orders_replayed_total'),
        },
      }));

      scope.put('/faults', async (request, reply) => {
        const parsed = faultsBody.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST' });
        const { dropSeqRate, orderDelayMs, simIntervalMs, simBurst } = parsed.data;
        if (dropSeqRate !== undefined) market.setDropSeqRate(dropSeqRate);
        if (orderDelayMs !== undefined) faults.orderDelayMs = orderDelayMs;
        if (simIntervalMs !== undefined || simBurst !== undefined) {
          market.startSimulator(simIntervalMs ?? market.faults.simIntervalMs, simBurst);
        }
        metrics.inc('hoga_admin_actions_total', { action: 'faults' });
        request.log.warn({ change: parsed.data }, 'admin: faults changed');
        return { ...market.faults, orderDelayMs: faults.orderDelayMs };
      });

      scope.put('/volatility', async (request, reply) => {
        const parsed = volatilityBody.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST' });
        const { multiplier, symbol } = parsed.data;
        if (symbol && !market.has(symbol)) return reply.code(404).send({ error: 'UNKNOWN_SYMBOL' });
        market.setVolatility(multiplier, symbol);
        metrics.inc('hoga_admin_actions_total', { action: 'volatility' });
        return { ok: true };
      });

      /** OTP 초기화(기기 분실 등). 감사 로그로 남긴다 */
      scope.post('/otp/reset', async (request, reply) => {
        const parsed = z.object({ userId: z.string().min(1).max(64) }).strict().safeParse(request.body);
        if (!parsed.success || !deps.otp) return reply.code(400).send({ error: 'BAD_REQUEST' });
        await deps.otp.reset(parsed.data.userId);
        metrics.inc('hoga_admin_actions_total', { action: 'otp_reset' });
        request.log.warn({ userId: parsed.data.userId }, 'admin: OTP reset');
        return { ok: true };
      });

      /** 지금 연결된 클라이언트를 모두 끊는다(재접속·재동기화 시연) */
      scope.post('/disconnect', async (request) => {
        // 여러 프로세스면 관리 채널로 알리기만 하고 수는 모른다(null)
        const closed = gateway.disconnectAll();
        metrics.inc('hoga_admin_actions_total', { action: 'disconnect' });
        request.log.warn({ closed }, 'admin: disconnected all clients');
        return { closed };
      });
    },
    { prefix: '/admin/api' },
  );
}
