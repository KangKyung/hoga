'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('..');

test('coreVersion은 앱과 같은 코어 버전을 돌려준다', () => {
  assert.equal(core.coreVersion(), '0.2.0-m2');
});

test('tickSize 가격대 경계', () => {
  const cases = [
    [1999, 1], [2000, 5], [4999, 5], [5000, 10], [19999, 10], [20000, 50],
    [49999, 50], [50000, 100], [199999, 100], [200000, 500], [499999, 500], [500000, 1000],
  ];
  for (const [price, tick] of cases) assert.equal(core.tickSize(price), tick, `price=${price}`);
});

test('tickSize 잘못된 입력', () => {
  assert.equal(core.tickSize(0), 0);
  assert.throws(() => core.tickSize(1000.5), TypeError);
  assert.throws(() => core.tickSize('1000'), TypeError);
  assert.throws(() => core.tickSize(Number.MAX_SAFE_INTEGER + 2), TypeError);
});

test('roundToTick · priceLimits', () => {
  assert.equal(core.roundToTick(71250, 'down'), 71200);
  assert.equal(core.roundToTick(4998, 'up'), 5000);
  assert.throws(() => core.roundToTick(100, 'sideways'), TypeError);
  assert.deepEqual(core.priceLimits(10000), { lower: 7000, upper: 13000 });
});

test('validateOrder는 C++ 규칙을 그대로 쓴다', () => {
  const policy = { basePrice: 10000 };
  assert.equal(core.validateOrder({ side: 'bid', price: 10050, qty: 1 }, policy), 'NONE');
  assert.equal(core.validateOrder({ side: 'bid', price: 10005, qty: 1 }, policy), 'OFF_TICK');
  assert.equal(core.validateOrder({ side: 'bid', price: 13010, qty: 1 }, policy), 'OUT_OF_PRICE_LIMIT');
  assert.equal(core.validateOrder({ side: 'bid', type: 'market', qty: 1 }, policy), 'NONE');
  assert.throws(() => core.validateOrder({ side: 'buy', price: 10000, qty: 1 }), TypeError);
});

test('MatchingEngine: 가격·시간 우선 체결과 변경분', () => {
  const engine = new core.MatchingEngine({ basePrice: 10000 });
  const first = engine.submit({ side: 'ask', price: 10050, qty: 3 });
  engine.submit({ side: 'ask', price: 10000, qty: 2 });
  assert.equal(first.status, 'NEW');

  const taker = engine.submit({ side: 'bid', price: 10050, qty: 4 });
  assert.equal(taker.status, 'FILLED');
  assert.deepEqual(taker.fills.map((f) => [f.price, f.qty]), [[10000, 2], [10050, 2]]);
  assert.deepEqual(taker.changes, [
    { side: 'ask', price: 10000, qty: 0 },
    { side: 'ask', price: 10050, qty: 1 },
  ]);
  assert.equal(engine.lastPrice, 10050);
  assert.deepEqual(engine.depth('ask', 5), [{ price: 10050, qty: 1 }]);

  assert.equal(engine.cancel(first.id).status, 'CANCELLED');
  assert.equal(engine.cancel(first.id).reject, 'UNKNOWN_ORDER');
  assert.equal(engine.restingOrderCount, 0);
});

test('MatchingEngine: 잘못된 주문은 거부, 잘못된 형식은 TypeError', () => {
  const engine = new core.MatchingEngine({ basePrice: 10000 });
  const r = engine.submit({ side: 'bid', price: 10005, qty: 1 });
  assert.equal(r.status, 'REJECTED');
  assert.equal(r.reject, 'OFF_TICK');
  assert.equal(r.id, 0);
  assert.throws(() => engine.submit({ side: 'bid', price: 10000, qty: 1.5 }), TypeError);
  assert.throws(() => new core.MatchingEngine({}), TypeError);
});
