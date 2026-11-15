import type { FastifyInstance } from 'fastify';

import type { AuthService } from '../auth/auth.js';
import type { IdempotencyStore } from '../idempotency.js';
import type { Market } from '../market/market.js';
import type { Metrics } from '../metrics.js';
import { OrderTracker, type OrderRecord } from '../orders/tracker.js';
import { idempotencyKey, orderBody, type OrderBody } from '../protocol.js';
import { requireUser } from './auth.js';

export type { OrderRecord };

export interface OrderRouteDeps {
  market: Market;
  store: IdempotencyStore<OrderRecord>;
  tracker: OrderTracker;
  auth: AuthService;
  metrics: Metrics;
  /** 장애 주입: 처리 후 응답만 늦춘다 */
  responseDelayMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 같은 내용이면 같은 지문. 키를 다른 주문에 재사용하는 버그를 잡는다. */
const fingerprint = (body: OrderBody) =>
  JSON.stringify([body.symbol, body.side, body.type, body.price ?? 0, body.qty]);

export function registerOrderRoutes(app: FastifyInstance, deps: OrderRouteDeps): void {
  const { market, store, tracker, metrics } = deps;
  metrics.describe('hoga_orders_total', 'counter', 'Orders processed by final status');
  metrics.describe('hoga_orders_replayed_total', 'counter', 'Orders answered from the idempotency store');

  app.register(async (scope) => {
    // 이 범위의 모든 주문 API는 로그인한 사용자만. 멱등 키·조회·취소 모두 사용자별로 분리된다.
    scope.addHook('preHandler', requireUser(deps.auth));

    /**
     * 주문. Idempotency-Key 헤더 필수.
     * - 처음 보는 키: 처리 후 결과 저장 → 200
     * - 같은 키 + 같은 내용: 다시 처리하지 않고 처음 결과 → 200 (Idempotent-Replayed: true)
     * - 같은 키 + 처리 중: 409 (잠시 후 GET /orders/:key)
     * - 같은 키 + 다른 내용: 422
     * 규칙 위반(호가단위 등)은 형식 오류가 아니라 업무 거부라서 200 + status REJECTED로 돌려준다.
     */
    scope.post('/orders', async (request, reply) => {
      const userId = request.userId!;
      const keyResult = idempotencyKey.safeParse(request.headers['idempotency-key']);
      if (!keyResult.success) return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
      const bodyResult = orderBody.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.code(400).send({ error: 'BAD_REQUEST', issues: bodyResult.error.issues });
      }
      const key = keyResult.data;
      const body = bodyResult.data;
      if (!market.has(body.symbol)) return reply.code(404).send({ error: 'UNKNOWN_SYMBOL' });

      const storeKey = OrderTracker.userKey(userId, key);
      const begin = await store.begin(storeKey, fingerprint(body));
      if (begin.state === 'conflict') return reply.code(422).send({ error: 'IDEMPOTENCY_KEY_REUSED' });
      if (begin.state === 'pending') return reply.code(409).send({ error: 'IN_PROGRESS' });
      if (begin.state === 'done') {
        metrics.inc('hoga_orders_replayed_total');
        // 그 사이 체결로 상태가 바뀌었을 수 있으니 최신 기록을 돌려준다
        return reply.header('idempotent-replayed', 'true').send(tracker.get(userId, key) ?? begin.result);
      }

      let record: OrderRecord;
      try {
        const result = market.submit(body.symbol, {
          side: body.side,
          type: body.type,
          price: body.price ?? 0,
          qty: body.qty,
        });
        const now = Date.now();
        record = {
          key,
          userId,
          symbol: body.symbol,
          side: body.side,
          type: body.type,
          price: body.price ?? 0,
          qty: body.qty,
          orderId: result.id,
          status: result.status,
          reject: result.reject,
          filled: result.filled,
          resting: result.resting,
          fills: result.fills.map((f) => ({ price: f.price, qty: f.qty })),
          acceptedAt: now,
          updatedAt: now,
        };
        tracker.add(record);
        await store.complete(storeKey, record);
      } catch (err) {
        await store.abandon(storeKey);
        throw err;
      }
      metrics.inc('hoga_orders_total', { status: record.status });

      if (deps.responseDelayMs > 0) await sleep(deps.responseDelayMs);
      return reply.send(record);
    });

    /** 내 주문 목록(최신순) */
    scope.get<{ Querystring: { symbol?: string } }>('/orders', async (request) => {
      const list = tracker.list(request.userId!);
      return request.query.symbol ? list.filter((r) => r.symbol === request.query.symbol) : list;
    });

    /** 주문 결과 조회. 클라이언트는 타임아웃 시 이것으로 접수 여부를 확정한다. */
    scope.get<{ Params: { key: string } }>('/orders/:key', async (request, reply) => {
      const userId = request.userId!;
      const record = tracker.get(userId, request.params.key);
      if (record) return reply.send(record);
      const entry = await store.get(OrderTracker.userKey(userId, request.params.key));
      if (entry && !entry.result) return reply.code(202).send({ state: 'IN_PROGRESS' });
      // 다른 사용자의 키는 존재 여부도 알려 주지 않는다
      return reply.code(404).send({ error: 'NOT_FOUND' });
    });

    /** 대기 중인 내 주문 취소 */
    scope.post<{ Params: { key: string } }>('/orders/:key/cancel', async (request, reply) => {
      const record = tracker.get(request.userId!, request.params.key);
      if (!record) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (record.orderId === 0) return reply.code(409).send({ error: 'ORDER_NOT_ACCEPTED' });
      const result = market.cancel(record.symbol, record.orderId);
      if (result.status === 'CANCELLED') tracker.markCancelled(record);
      return reply.send({
        key: record.key,
        orderId: record.orderId,
        status: result.status,
        reject: result.reject,
      });
    });
  });
}
