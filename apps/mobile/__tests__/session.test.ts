/**
 * 로그아웃과 토큰 갱신이 겹칠 때: 갱신 응답이 로그아웃 뒤에 와도 다시 로그인 상태가 되지 않는다.
 */
const mockStore = new Map<string, string>();
const mockAuthTokens: string[] = [];
let mockResolveRefresh: ((v: unknown) => void) | undefined;

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
  secureStoreErrorCode: () => null,
}));
jest.mock('../src/native/hogaCore', () => ({
  hogaCore: {setAuthToken: (t: string) => mockAuthTokens.push(t), randomId: () => 'id'},
}));
jest.mock('../src/analytics/analytics', () => ({track: jest.fn()}));
jest.mock('../src/auth/otp', () => ({clearStepUp: jest.fn()}));
jest.mock('../src/api/http', () => {
  class HttpError extends Error {
    status = 0;
  }
  return {
    HttpError,
    setTokenSource: jest.fn(),
    request: jest.fn((path: string) => {
      if (path === '/auth/refresh') return new Promise(resolve => (mockResolveRefresh = resolve));
      if (path === '/auth/logout') return Promise.resolve({data: {}});
      return Promise.resolve({
        data: {accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 900, user: {id: 'u-demo', username: 'demo', name: 'd'}},
      });
    }),
  };
});

import {session} from '../src/auth/session';

afterEach(() => session.dispose());

test('갱신 중 로그아웃하면 늦게 온 갱신 응답을 버린다', async () => {
  await session.login('demo', 'pw', false);
  expect(session.getState().status).toBe('signedIn');

  const refreshing = session.tokens.refresh(); // 응답 대기 중
  await new Promise<void>(r => setImmediate(() => r()));
  await session.logout();
  expect(session.getState().status).toBe('signedOut');

  mockResolveRefresh!({
    data: {accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900, user: {id: 'u-demo', username: 'demo', name: 'd'}},
  });
  expect(await refreshing).toBeNull();
  expect(session.getState().status).toBe('signedOut');
  expect(mockStore.has('auth.refreshToken')).toBe(false);
  expect(mockAuthTokens.at(-1)).toBe('');
});
