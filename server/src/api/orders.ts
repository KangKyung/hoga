import type { FastifyInstance } from 'fastify';

import type { ExecutionResult } from '../core.js';
import type { IdempotencyStore } from '../idempotency.js';
import type { Market } from '../market/market.js';
import type { Metrics } from '../metrics.js';
import { idempotencyKey, orderBody, type OrderBody } from '../protocol.js';

export interface OrderRecord {
  key: string;
  symbol: string;
  side: OrderBody['side'];
  type: OrderBody['type'];
  price: number;
  qty: number;
  /** 거부되면 0 */
  orderId: number;
  status: ExecutionResult['status'];
  reject: ExecutionResult['reject'];
  filled: number;
  resting: number;
  fills: { price: number; qty: number }[];
  acceptedAt: number;
}

export interface OrderRouteDeps {
  market: Market;
  store: IdempotencyStore<OrderRecord>;
  metrics: Metrics;
  /** 장애 주입: 처리 후 응답만 늦춘다 */
  responseDelayMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 같은 내용이면 같은 지문. 키를 다른 주문에 재사용하는 버그를 잡는다. */
const fingerprint = (body: OrderBody) =>
  JSON.stringify([body.symbol, body.side, body.type, body.price ?? 0, body.qty]);

export function registerOrderRoutes(app: FastifyInstance, deps: OrderRouteDeps): void {
  const { market, store, metrics } = deps;
  metrics.describe('hoga_orders_total', 'counter', 'Orders processed by final status');
  metrics.describe('hoga_orders_replayed_total', 'counter', 'Orders answered from the idempotency store');

  /**
   * 주문. Idempotency-Key 헤더 필수.
   * - 처음 보는 키: 처리 후 결과 저장 → 200
   * - 같은 키 + 같은 내용: 다시 처리하지 않고 처음 결과 → 200 (Idempotent-Replayed: true)
   * - 같은 키 + 처리 중: 409 (잠시 후 GET /orders/:key)
   * - 같은 키 + 다른 내용: 422
   * 규칙 위반(호가단위 등)은 형식 오류가 아니라 업무 거부라서 200 + status REJECTED로 돌려준다.
   */
  app.post('/orders', async (request, reply) => {
    const keyResult = idempotencyKey.safeParse(request.headers['idempotency-key']);
    if (!keyResult.success) {
      return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    const bodyResult = orderBody.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', issues: bodyResult.error.issues });
    }
    const key = keyResult.data;
    const body = bodyResult.data;
    if (!market.has(body.symbol)) {
      return reply.code(404).send({ error: 'UNKNOWN_SYMBOL' });
    }

    const begin = await store.begin(key, fingerprint(body));
    if (begin.state === 'conflict') return reply.code(422).send({ error: 'IDEMPOTENCY_KEY_REUSED' });
    if (begin.state === 'pending') return reply.code(409).send({ error: 'IN_PROGRESS' });
    if (begin.state === 'done') {
      metrics.inc('hoga_orders_replayed_total');
      return reply.header('idempotent-replayed', 'true').send(begin.result);
    }

    let record: OrderRecord;
    try {
      const result = market.submit(body.symbol, {
        side: body.side,
        type: body.type,
        price: body.price ?? 0,
        qty: body.qty,
      });
      record = {
        key,
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
        acceptedAt: Date.now(),
      };
      await store.complete(key, record);
    } catch (err) {
      await store.abandon(key);
      throw err;
    }
    metrics.inc('hoga_orders_total', { status: record.status });

    if (deps.responseDelayMs > 0) await sleep(deps.responseDelayMs);
    return reply.send(record);
  });

  /** 주문 결과 조회. 클라이언트는 타임아웃 시 이것으로 접수 여부를 확정한다. */
  app.get<{ Params: { key: string } }>('/orders/:key', async (request, reply) => {
    const entry = await store.get(request.params.key);
    if (!entry) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!entry.result) return reply.code(202).send({ state: 'IN_PROGRESS' });
    return reply.send(entry.result);
  });

  /** 대기 중인 주문 취소 */
  app.post<{ Params: { key: string } }>('/orders/:key/cancel', async (request, reply) => {
    const entry = await store.get(request.params.key);
    if (!entry?.result) return reply.code(404).send({ error: 'NOT_FOUND' });
    const { symbol, orderId } = entry.result;
    if (orderId === 0) return reply.code(409).send({ error: 'ORDER_NOT_ACCEPTED' });
    const result = market.cancel(symbol, orderId);
    return reply.send({ key: request.params.key, orderId, status: result.status, reject: result.reject });
  });
}
