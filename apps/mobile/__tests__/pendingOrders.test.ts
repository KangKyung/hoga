/**
 * 미확정 주문 목록은 사용자별: 같은 기기에서 다른 사용자가 로그인해도 이전 사용자의 주문을 조회·삭제하지 않는다.
 */
const mockStore = new Map<string, string>();
let mockUser: string | null = 'u-a';

jest.mock('../src/native/security', () => ({
  secureStore: {
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      mockStore.set(k, v);
    }),
    remove: jest.fn(async (k: string) => {
      mockStore.delete(k);
    }),
  },
}));
jest.mock('../src/auth/session', () => ({
  session: {
    getState: () =>
      mockUser ? {status: 'signedIn', user: {id: mockUser, username: mockUser, name: mockUser}} : {status: 'signedOut'},
  },
}));
jest.mock('../src/auth/otp', () => ({stepUpToken: () => null}));
jest.mock('../src/native/hogaCore', () => ({hogaCore: {randomId: () => 'id'}}));
jest.mock('../src/api/http', () => ({request: jest.fn(), HttpError: class {}, NetworkError: class {}, TimeoutError: class {}}));

import {pendingOrders} from '../src/orders/orderService';

const draft = {symbol: '000001', side: 'bid' as const, type: 'limit' as const, price: 70_000, qty: 1};

test('목록은 지금 사용자 것만, 다른 사용자 것은 남겨 둔다', async () => {
  const createdAt = Date.now();
  await pendingOrders.add({key: 'k-a', draft, createdAt});
  mockUser = 'u-b';
  expect(await pendingOrders.list()).toEqual([]);
  await pendingOrders.add({key: 'k-b', draft, createdAt});
  expect((await pendingOrders.list()).map(o => o.key)).toEqual(['k-b']);

  mockUser = 'u-a';
  expect(await pendingOrders.list()).toEqual([{key: 'k-a', draft, createdAt, userId: 'u-a'}]);

  mockUser = null;
  expect(await pendingOrders.list()).toEqual([]);
});

test('다른 사용자의 오래된(7일 넘은) 미확정 주문은 정리한다', async () => {
  mockStore.clear();
  mockUser = 'u-old';
  await pendingOrders.add({key: 'k-old', draft, createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000});
  await pendingOrders.add({key: 'k-recent', draft, createdAt: Date.now() - 60_000});
  mockUser = 'u-new';
  expect(await pendingOrders.list()).toEqual([]);
  mockUser = 'u-old';
  expect((await pendingOrders.list()).map(o => o.key)).toEqual(['k-recent']);
});
