/**
 * 주문 부하 + 멱등성 (k6, 03 문서의 4번).
 *
 * - 초당 RATE건(기본 200) 지정가 주문을 DURATION 동안 보낸다.
 * - 10%는 직전 주문을 "같은 멱등 키 + 같은 내용"으로 다시 보낸다(응답을 못 받아 재전송한 상황).
 *   → 서버는 새로 처리하지 않고 처음 결과(같은 orderId, idempotent-replayed: true)를 돌려줘야 한다.
 * - 끝나면 서버가 실제로 만든 주문 수를 관리 API로 읽어 "새 키로 보낸 주문 수"와 같아야 한다(중복 생성 0).
 *
 * 실행: k6 run -e BASE=http://localhost:8090 loadtest/orders.js
 */
import http from 'k6/http';
import {check} from 'k6';
import exec from 'k6/execution';
import {Counter, Gauge, Trend} from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:8090';
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || '60s';
const ADMIN = {'x-admin-token': __ENV.ADMIN_TOKEN || 'hoga-admin-dev-token'};
const USERS = [
  {username: 'demo', password: 'hoga-demo-1234'},
  {username: 'trader2', password: 'hoga-trader-5678'},
];

const newOrders = new Counter('orders_new');
const retries = new Counter('orders_retry');
const replayMismatch = new Counter('replay_mismatch');
const serverCreated = new Gauge('server_orders_created');
const orderLatency = new Trend('order_latency', true);

export const options = {
  scenarios: {
    orders: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
    verify: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      startTime: `${Number(DURATION.replace('s', '')) + 5}s`,
      exec: 'verify',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    replay_mismatch: ['count==0'],
    order_latency: ['p(99)<200'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const counters = () => http.get(`${BASE}/admin/api/state`, {headers: ADMIN}).json('counters');

export function setup() {
  const tokens = USERS.map(u => http.post(`${BASE}/auth/login`, JSON.stringify(u), {headers: {'content-type': 'application/json'}}).json('accessToken'));
  const symbols = http.get(`${BASE}/symbols`).json();
  return {tokens, symbols, ordersBefore: counters().orders};
}

// VU마다 직전 주문(재전송용)
let last = null;

export default function (data) {
  const retry = last && Math.random() < 0.1;
  let order = last;
  if (!retry) {
    const s = data.symbols[Math.floor(Math.random() * data.symbols.length)];
    const side = Math.random() < 0.5 ? 'bid' : 'ask';
    const ticks = 1 + Math.floor(Math.random() * 5);
    const price = side === 'bid' ? s.lastPrice - ticks * s.tickSize : s.lastPrice + ticks * s.tickSize;
    order = {
      key: `k6-${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${Date.now()}`,
      token: data.tokens[exec.vu.idInTest % data.tokens.length],
      body: JSON.stringify({symbol: s.code, side, type: 'limit', price, qty: 1 + Math.floor(Math.random() * 10)}),
      orderId: null,
    };
  }
  const res = http.post(`${BASE}/orders`, order.body, {
    headers: {'content-type': 'application/json', authorization: `Bearer ${order.token}`, 'idempotency-key': order.key},
    tags: {kind: retry ? 'retry' : 'new'},
  });
  orderLatency.add(res.timings.duration);
  const ok = check(res, {'200': r => r.status === 200});
  if (!ok) return;
  const orderId = res.json('orderId');
  if (retry) {
    retries.add(1);
    const same = orderId === order.orderId && res.headers['Idempotent-Replayed'] === 'true';
    if (!same) replayMismatch.add(1);
  } else {
    newOrders.add(1);
    order.orderId = orderId;
    last = order;
  }
}

/** 서버가 실제로 만든 주문 수 − 새 키로 보낸 수 = 중복 생성 수(0이어야 한다) */
export function verify(data) {
  const created = counters().orders - data.ordersBefore;
  serverCreated.add(created);
  // 새 주문 수는 k6 메트릭이라 여기서 못 읽으므로 handleSummary에서 비교한다. 여기선 서버 값만 남긴다.
  console.log(`server created ${created} orders`);
}

export function handleSummary(data) {
  const created = data.metrics.server_orders_created?.values.value ?? NaN;
  const sent = data.metrics.orders_new?.values.count ?? NaN;
  const out = {
    sentNew: sent,
    sentRetry: data.metrics.orders_retry?.values.count ?? 0,
    serverCreated: created,
    duplicatesCreated: created - sent,
    replayMismatch: data.metrics.replay_mismatch?.values.count ?? 0,
    latency: data.metrics.order_latency?.values,
    failedRate: data.metrics.http_req_failed?.values.rate,
  };
  return {
    stdout: `\norders: ${JSON.stringify(out, null, 2)}\n`,
    [__ENV.OUT || 'loadtest/results/orders.json']: JSON.stringify(out, null, 2),
  };
}
