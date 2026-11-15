'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('..');

test('coreVersion은 앱과 같은 코어 버전을 돌려준다', () => {
  assert.equal(core.coreVersion(), '0.0.1-m0');
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
