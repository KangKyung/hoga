/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

// Jest에는 네이티브 런타임이 없으므로 TurboModule을 목으로 대체한다.
// 실제 C++·네이티브 동작은 core/(GoogleTest)·서버 통합 테스트·기기 실행으로 검증한다.
const mockBook = {
  subscribed: true,
  seq: 42,
  sync: 'live',
  bids: [
    [71_200, 120],
    [71_100, 300],
  ],
  asks: [
    [71_300, 80],
    [71_400, 50],
  ],
  lastUpdateMs: Date.now(),
};

jest.mock('../specs/NativeHogaCore', () => ({
  __esModule: true,
  default: {
    coreVersion: () => '0.3.0-m3',
    tickSize: () => 100,
    roundToTick: (p: number, mode: string) => (mode === 'up' ? Math.ceil(p / 100) * 100 : Math.floor(p / 100) * 100),
    priceLimits: () => ({lower: 49_900, upper: 92_500}),
    validateOrder: () => 'NONE',
    randomId: () => 'key-123',
    connect: jest.fn(),
    setAuthToken: jest.fn(),
    disconnect: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    getBook: () => mockBook,
    getTrades: () => [{price: 71_300, qty: 10, aggressor: 'bid', ts: 0}],
    getStats: () => ({state: 'open', attempt: 0, messages: 1, gaps: 0, resyncs: 0, reconnects: 0, parseErrors: 0, lastError: ''}),
    onConnectionState: () => ({remove: jest.fn()}),
    onOrderEvent: () => ({remove: jest.fn()}),
  },
}));

const mockStore = new Map<string, string>();
jest.mock('../specs/NativeSecureStore', () => ({
  __esModule: true,
  default: {
    setItem: async (k: string, v: string) => {
      mockStore.set(k, v);
    },
    getItem: async (k: string) => mockStore.get(k) ?? null,
    removeItem: async (k: string) => {
      mockStore.delete(k);
    },
    biometryType: async () => 'none',
  },
}));

jest.mock('../specs/NativeDeviceGuard', () => ({
  __esModule: true,
  default: {
    getStatus: () => ({compromised: false, reasons: [], emulator: true, debugger: false, captured: false}),
    setSecureScreen: jest.fn(),
  },
}));

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

import App from '../App';
import {session} from '../src/auth/session';
import NativeDeviceGuard from '../specs/NativeDeviceGuard';
import NativeHogaCore from '../specs/NativeHogaCore';

const symbols = [{code: '000001', name: '가상전자', basePrice: 71_200, lastPrice: 71_200, tickSize: 100, limits: {lower: 49_900, upper: 92_500}}];
const tokens = {accessToken: 'access-1', refreshToken: 'refresh-token-0123456789', expiresIn: 900, user: {id: 'u-demo', username: 'demo', name: '데모 사용자'}};

function respond(status: number, body: unknown) {
  return {ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body};
}

beforeEach(() => {
  mockStore.clear();
  globalThis.fetch = jest.fn(async (url: string) => {
    if (url.endsWith('/symbols')) return respond(200, symbols);
    if (url.endsWith('/auth/login')) return respond(200, tokens);
    if (url.includes('/orders')) return respond(200, []);
    return respond(404, {});
  }) as unknown as typeof fetch;
});

const flush = () => new Promise<void>(resolve => setTimeout(() => resolve(), 0));

test('login → watchlist → quote screen → order sheet', async () => {
  let r: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    r = ReactTestRenderer.create(<App />);
    await flush();
  });
  expect(NativeHogaCore.connect).toHaveBeenCalledWith('ws://localhost:8080/ws', 'http://localhost:8080');
  expect(NativeDeviceGuard.setSecureScreen).toHaveBeenCalledWith(true);

  // 저장된 세션이 없으므로 로그인 화면
  await ReactTestRenderer.act(async () => {
    r!.root.findByProps({testID: 'password'}).props.onChangeText('hoga-demo-1234');
  });
  await ReactTestRenderer.act(async () => {
    r!.root.findByProps({testID: 'login'}).props.onPress();
    await flush();
    await flush();
  });

  // 로그인: 리프레시 토큰은 보안 저장소에, 액세스 토큰은 C++ 시세 클라이언트로
  expect(mockStore.get('auth.refreshToken')).toBe(tokens.refreshToken);
  expect(NativeHogaCore.setAuthToken).toHaveBeenCalledWith('access-1');
  expect(NativeHogaCore.subscribe).toHaveBeenCalledWith(['000001']);

  await ReactTestRenderer.act(async () => {
    r!.root.findByProps({testID: 'watch-000001'}).props.onPress();
    await flush();
  });
  expect(r!.root.findAllByProps({testID: 'ask-71300'}).length).toBeGreaterThan(0);

  // 매도 호가를 누르면 그 가격으로 매수 주문 창
  await ReactTestRenderer.act(async () => {
    r!.root.findAllByProps({testID: 'ask-71300'})[0]!.props.onPress();
  });
  expect(r!.root.findByProps({testID: 'orderPrice'}).props.children).toBe('71,300');

  await ReactTestRenderer.act(async () => r!.unmount());
});

afterAll(() => session.dispose());
