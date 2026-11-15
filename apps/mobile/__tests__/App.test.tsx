/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

// Jest에는 네이티브 런타임이 없으므로 C++ TurboModule을 목으로 대체한다.
// 실제 C++ 동작은 core/(GoogleTest)·bindings/node(node:test)·기기 실행으로 검증한다.
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
    coreVersion: () => '0.2.0-m2',
    tickSize: () => 100,
    roundToTick: (p: number) => p,
    connect: jest.fn(),
    disconnect: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    getBook: () => mockBook,
    getTrades: () => [{price: 71_300, qty: 10, aggressor: 'bid', ts: 0}],
    getStats: () => ({state: 'open', attempt: 0, messages: 1, gaps: 0, resyncs: 0, reconnects: 0, parseErrors: 0, lastError: ''}),
    onConnectionState: () => ({remove: jest.fn()}),
  },
}));

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

import App from '../App';
import NativeHogaCore from '../specs/NativeHogaCore';

const symbols = [{code: '000001', name: '가상전자', basePrice: 71_200, lastPrice: 71_200, tickSize: 100, limits: {lower: 49_900, upper: 92_500}}];

beforeEach(() => {
  globalThis.fetch = jest.fn(async () => ({ok: true, status: 200, json: async () => symbols})) as unknown as typeof fetch;
});

const flush = () => new Promise<void>(resolve => setTimeout(() => resolve(), 0));

test('connects, subscribes to server symbols and opens the quote screen', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
    await flush();
  });

  expect(NativeHogaCore.connect).toHaveBeenCalledWith('ws://localhost:8080/ws', 'http://localhost:8080');
  expect(NativeHogaCore.subscribe).toHaveBeenCalledWith(['000001']);

  const row = renderer!.root.findByProps({testID: 'watch-000001'});
  await ReactTestRenderer.act(async () => {
    row.props.onPress();
  });

  // 매도 2단계 + 매수 2단계가 그려진다
  expect(renderer!.root.findAllByProps({testID: 'ask-71300'}).length).toBeGreaterThan(0);
  expect(renderer!.root.findAllByProps({testID: 'bid-71200'}).length).toBeGreaterThan(0);
  const last = renderer!.root.findByProps({testID: 'lastPrice'});
  expect(last.props.children).toBe('71,300');

  await ReactTestRenderer.act(async () => renderer!.unmount());
  expect(NativeHogaCore.disconnect).toHaveBeenCalled();
});
