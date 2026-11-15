/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

// Jest에는 네이티브 런타임이 없으므로 C++ TurboModule을 목으로 대체한다.
// 실제 C++ 동작은 core/(GoogleTest)와 bindings/node(node:test)에서 검증한다.
jest.mock('../specs/NativeHogaCore', () => ({
  __esModule: true,
  default: {
    coreVersion: () => '0.0.1-m0',
    tickSize: (price: number) => {
      if (!Number.isSafeInteger(price)) {
        throw new Error('price must be a safe integer');
      }
      return price < 2000 ? 1 : 5;
    },
  },
}));

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

import App from '../App';

test('renders core version from the TurboModule', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });
  const version = renderer!.root.findByProps({testID: 'coreVersion'});
  expect(version.props.children).toBe('0.0.1-m0');
});
