import type { FastifyInstance } from 'fastify';

import type { Ledger } from '../account/ledger.js';
import type { AuthService } from '../auth/auth.js';
import { validateOrder, type RejectReason } from '../core.js';
import type { OtpService } from '../auth/otp.js';
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
  /** OTP를 켠 사용자는 x-step-up 헤더(OTP로 받은 단기 토큰)가 있어야 주문할 수 있다 */
  otp?: OtpService;
  metrics: Metrics;
  /** 계좌 원장(주문가능금액·매도가능수량). 없으면 확인하지 않는다 */
  ledger?: Ledger;
  /** 장애 주입: 처리 후 응답만 늦춘다(관리 콘솔에서 바꿀 수 있어 매번 읽는다) */
  responseDelayMs: () => number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 같은 내용이면 같은 지문. 키를 다른 주문에 재사용하는 버그를 잡는다. */
const fingerprint = (body: OrderBody) =>
  JSON.stringify([body.symbol, body.side, body.type, body.price ?? 0, body.qty, body.amendOf ?? '']);
const recordFingerprint = (r: OrderRecord) => JSON.stringify([r.symbol, r.side, r.type, r.price, r.qty, r.amendOf ?? '']);

export function registerOrderRoutes(app: FastifyInstance, deps: OrderRouteDeps): void {
  const { market, store, tracker, metrics } = deps;
  metrics.describe('hoga_orders_total', 'counter', 'Orders processed by final status');
  metrics.describe('hoga_orders_replayed_total', 'counter', 'Orders answered from the idempotency store');

  /**
   * 업무 처리(동기). 같은 이벤트 루프 안에서 확인 → 접수가 끝나 다른 주문이 끼어들 틈이 없다.
   * 정정: 원주문 잔량에서 qty를 빼고(C++ reduce, 남은 잔량은 순서 유지) 새 가격으로 새 주문을 낸다.
   * 규칙 위반은 엔진에 닿기 전에 REJECTED 기록으로 끝낸다(원주문을 건드리지 않는다).
   */
  function execute(userId: string, key: string, body: OrderBody): OrderRecord {
    const now = Date.now();
    const order = { side: body.side, type: body.type, price: body.price ?? 0, qty: body.qty };
    const base: OrderRecord = {
      key,
      userId,
      symbol: body.symbol,
      ...order,
      orderId: 0,
      status: 'REJECTED',
      reject: 'NONE',
      filled: 0,
      resting: 0,
      fills: [],
      acceptedAt: now,
      updatedAt: now,
      ...(body.amendOf ? { amendOf: body.amendOf } : {}),
    };
    const reject = (reason: RejectReason): OrderRecord => ({ ...base, reject: reason });

    let original: OrderRecord | undefined;
    if (body.amendOf) {
      original = tracker.get(userId, body.amendOf);
      if (!original || original.resting === 0 || original.symbol !== body.symbol || original.side !== body.side) {
        return reject('UNKNOWN_ORDER');
      }
      if (body.type !== 'limit') return reject('INVALID_PRICE');
      if (body.qty > original.resting) return reject('EXCEEDS_OPEN_QTY');
      // 원주문을 줄이기 전에 새 주문이 규칙에 맞는지 먼저 본다
      const rule = validateOrder(order, { basePrice: market.info(body.symbol).basePrice });
      if (rule !== 'NONE') return reject(rule);
      if (market.mode(body.symbol) === 'HALTED') return reject('MARKET_CLOSED');
    }
    const account = deps.ledger?.check(userId, body.symbol, order, original && { key: original.key, qty: body.qty });
    if (account && account !== 'NONE') return reject(account);

    if (original) {
      const reduced = market.reduce(original.symbol, original.orderId, body.qty);
      if (reduced.status === 'REJECTED') return reject(reduced.reject);
      tracker.markAmended(original, body.qty);
    }
    const result = market.submit(body.symbol, order);
    return {
      ...base,
      orderId: result.id,
      status: result.status,
      reject: result.reject,
      filled: result.filled,
      resting: result.resting,
      fills: result.fills.map((f) => ({ price: f.price, qty: f.qty })),
    };
  }

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
      // 멱등 키를 잡기 전에 확인한다 → OTP 입력 뒤 같은 키로 다시 보내도 처음 주문으로 처리된다
      const stepUp = request.headers['x-step-up'];
      if (deps.otp && !(await deps.otp.allowsOrder(userId, typeof stepUp === 'string' ? stepUp : undefined))) {
        return reply.code(403).send({ error: 'OTP_REQUIRED' });
      }

      // 멱등 키 저장소는 24시간 뒤 잊지만 주문 기록은 남는다. 기록이 있는 키는 기간과 상관없이 다시 실행하지 않는다
      // (다시 실행하면 같은 키에 묶인 원장 예약·주문 기록을 덮어써 첫 주문이 고아가 되고 예수금이 음수가 될 수 있다)
      const existing = tracker.get(userId, key);
      if (existing) {
        if (recordFingerprint(existing) !== fingerprint(body)) return reply.code(422).send({ error: 'IDEMPOTENCY_KEY_REUSED' });
        metrics.inc('hoga_orders_replayed_total');
        return reply.header('idempotent-replayed', 'true').send(existing);
      }

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
        record = execute(userId, key, body);
      } catch (err) {
        // 엔진에 닿기 전 실패만 키를 풀어 재시도를 허용한다
        await store.abandon(storeKey);
        throw err;
      }
      tracker.add(record);
      try {
        await store.complete(storeKey, record);
      } catch (err) {
        // 주문은 이미 엔진에 들어갔다. 키를 풀면 재시도가 같은 주문을 한 번 더 낸다 → 풀지 않고 결과를 돌려준다.
        // 같은 키 재시도는 위의 주문 기록 확인으로 이 결과를 받는다
        request.log.error({ err, key: storeKey }, 'idempotency complete failed after execution');
      }
      metrics.inc('hoga_orders_total', { status: record.status });

      const delay = deps.responseDelayMs();
      if (delay > 0) await sleep(delay);
      return reply.send(record);
    });

    /** 내 주문 목록(최신순). status=open이면 미체결(잔량 있는 주문)만 */
    scope.get<{ Querystring: { symbol?: string; status?: string } }>('/orders', async (request) => {
      const { symbol, status } = request.query;
      return tracker
        .list(request.userId!, status === 'open' ? 500 : 50)
        .filter((r) => (!symbol || r.symbol === symbol) && (status !== 'open' || r.resting > 0));
    });

    /** 잔고: 예수금·주문가능금액·보유 종목 평가 */
    scope.get('/account', async (request, reply) => {
      if (!deps.ledger?.has(request.userId!)) return reply.code(404).send({ error: 'NO_ACCOUNT' });
      return deps.ledger.summary(request.userId!);
    });

    /** 주문가능: 주문 화면의 "최대" 수량(C++ maxOrderQty) */
    scope.get<{ Querystring: { symbol?: string; side?: string; type?: string; price?: string } }>(
      '/account/orderable',
      async (request, reply) => {
        const { symbol = '', side, type = 'limit' } = request.query;
        const price = Number(request.query.price ?? 0);
        if (!market.has(symbol) || (side !== 'bid' && side !== 'ask') || (type !== 'limit' && type !== 'market')) {
          return reply.code(400).send({ error: 'BAD_REQUEST' });
        }
        if (!Number.isSafeInteger(price) || price < 0) return reply.code(400).send({ error: 'BAD_REQUEST' });
        if (!deps.ledger?.has(request.userId!)) return reply.code(404).send({ error: 'NO_ACCOUNT' });
        return deps.ledger.orderable(request.userId!, symbol, side, type, price);
      },
    );

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
