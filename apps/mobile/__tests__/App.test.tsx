/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

// 화면 흐름 시험은 CI에서 iOS·Android 빌드와 동시에 돌아 기본 5초가 모자랄 수 있다
jest.setTimeout(30_000);

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

/** "JS 경유" 실험 모드가 등록한 시세 리스너 */
const mockMarketListeners: Array<(json: string) => void> = [];
jest.mock('../specs/NativeHogaCore', () => ({
  __esModule: true,
  default: {
    coreVersion: () => '0.3.0-m3',
    tickSize: () => 100,
    roundToTick: (p: number, mode: string) => (mode === 'up' ? Math.ceil(p / 100) * 100 : Math.floor(p / 100) * 100),
    priceLimits: () => ({lower: 49_900, upper: 92_500}),
    validateOrder: () => 'NONE',
    checkAccount: () => 'NONE',
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
    setMarketTap: jest.fn(),
    onMarketMessage: (listener: (json: string) => void) => {
      mockMarketListeners.push(listener);
      return {
        remove: () => mockMarketListeners.splice(mockMarketListeners.indexOf(listener), 1),
      };
    },
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

jest.mock('../specs/NativeDocumentCapture', () => ({
  __esModule: true,
  default: {isCameraAvailable: () => false, capture: jest.fn()},
}));

jest.mock('../specs/NativeDeviceGuard', () => ({
  __esModule: true,
  default: {
    getStatus: () => ({compromised: false, reasons: [], emulator: true, debugger: false, captured: false}),
    setSecureScreen: jest.fn(),
  },
}));

// 웹뷰: 네이티브 없이 props를 잡아 두고, 테스트가 웹 → 앱 메시지를 흉내 낸다
const mockWebView = {props: null as null | Record<string, any>, inject: jest.fn()};
jest.mock('react-native-webview', () => {
  const ReactMock = require('react');
  const {View} = require('react-native');
  const WebView = ReactMock.forwardRef((props: Record<string, any>, ref: any) => {
    mockWebView.props = props;
    ReactMock.useImperativeHandle(ref, () => ({injectJavaScript: mockWebView.inject}));
    return ReactMock.createElement(View, {testID: 'mockWebView'});
  });
  return {__esModule: true, WebView, default: WebView};
});

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

import App from '../App';
import {debugSink} from '../src/analytics/analytics';
import {getLocale, resetI18nForTest} from '../src/i18n';
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
  mockWebView.props = null;
  mockWebView.inject.mockClear();
  resetI18nForTest();
  globalThis.fetch = jest.fn(async (url: string) => {
    if (url.endsWith('/symbols')) return respond(200, symbols);
    if (url.endsWith('/auth/login')) return respond(200, tokens);
    if (url.includes('/orders')) return respond(200, []);
    if (url.includes('/book/000001')) return respond(200, {t: 'snap', sym: '000001', seq: 100, ts: 0, bids: [[70_000, 5]], asks: [[70_100, 7]]});
    return respond(404, {});
  }) as unknown as typeof fetch;
});

// 세션은 앱 전체에서 하나라 테스트마다 로그아웃 상태로 되돌린다
afterEach(async () => {
  await session.logout();
  session.dispose();
});

const flush = () => new Promise<void>(resolve => setTimeout(() => resolve(), 0));

async function renderSignedIn() {
  let r: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    r = ReactTestRenderer.create(<App />);
    await flush();
  });
  await ReactTestRenderer.act(async () => {
    r!.root.findByProps({testID: 'password'}).props.onChangeText('hoga-demo-1234');
  });
  await ReactTestRenderer.act(async () => {
    r!.root.findByProps({testID: 'login'}).props.onPress();
    await flush();
    await flush();
  });
  return r!;
}

/** 웹 화면이 보낸 것처럼 메시지를 넣는다 */
async function fromWeb(envelope: unknown, url = 'http://localhost:8080/web/stock/?symbol=000001') {
  await ReactTestRenderer.act(async () => {
    mockWebView.props!.onMessage({nativeEvent: {data: JSON.stringify(envelope), url}});
  });
}

const lastInjected = () => {
  const script: string = mockWebView.inject.mock.calls.at(-1)?.[0] ?? '';
  const match = /receive\((".*")\); true;$/.exec(script);
  return match ? JSON.parse(JSON.parse(match[1]!)) : null;
};

test('login → watchlist → quote screen → order sheet', async () => {
  let r: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    r = ReactTestRenderer.create(<App />);
    await flush();
  });
  expect(NativeHogaCore.connect).toHaveBeenCalledWith('ws://localhost:8080/ws?proto=bin', 'http://localhost:8080');
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

  await ReactTestRenderer.act(async () => {
    r!.root.findByProps({testID: 'watch-000001'}).props.onPress();
    await flush();
  });
  // 호가 화면이 그 종목을 구독한다(모아서 보내므로 잠깐 뒤)
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 200));
  });
  expect(NativeHogaCore.subscribe).toHaveBeenCalledWith(['000001']);
  expect(r!.root.findAllByProps({testID: 'ask-71300'}).length).toBeGreaterThan(0);

  // 매도 호가를 누르면 그 가격으로 매수 주문 창
  await ReactTestRenderer.act(async () => {
    r!.root.findAllByProps({testID: 'ask-71300'})[0]!.props.onPress();
  });
  expect(r!.root.findByProps({testID: 'orderPrice'}).props.children).toBe('71,300');

  await ReactTestRenderer.act(async () => r!.unmount());
});

afterAll(() => session.dispose());

test('info tab: web page handshake, live quote, and order button opens the native sheet', async () => {
  const r = await renderSignedIn();
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'watch-000001'}).props.onPress();
    await flush();
  });
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'tab-info'}).props.onPress();
  });

  // 우리 서버 주소만 열고, 언어를 주소로 넘긴다
  expect(mockWebView.props!.source.uri).toBe('http://localhost:8080/web/stock/?symbol=000001&lang=ko');
  let allowed: boolean | undefined;
  await ReactTestRenderer.act(async () => {
    allowed = mockWebView.props!.onShouldStartLoadWithRequest({url: 'https://evil.example/phish'});
  });
  expect(allowed).toBe(false);
  expect(mockWebView.props!.onShouldStartLoadWithRequest({url: 'http://localhost:8080/web/notices/'})).toBe(true);

  // hello → init(언어·프로토콜), 이어서 현재가
  await fromWeb({v: 1, type: 'hello', payload: {page: 'stock_info', protocol: 1}});
  const injected = mockWebView.inject.mock.calls.map(c => JSON.parse(JSON.parse(/receive\((".*")\); true;$/.exec(c[0])![1]!)));
  expect(injected[0]).toMatchObject({v: 1, type: 'init', payload: {protocol: 1, locale: 'ko'}});
  expect(injected.find(m => m.type === 'quote')).toMatchObject({payload: {symbol: '000001', price: 71_300}});

  // 다른 출처에서 온 메시지·다른 종목 주문 요청은 무시
  await fromWeb({v: 1, type: 'openOrder', payload: {symbol: '000001', side: 'bid'}}, 'https://evil.example/');
  await fromWeb({v: 1, type: 'openOrder', payload: {symbol: '000002', side: 'bid'}});
  expect(r.root.findAllByProps({testID: 'fromWebNotice'})).toHaveLength(0);
  expect(debugSink.recent().some(e => e.name === 'bridge_rejected' && e.params.reason === 'origin')).toBe(true);

  // 웹의 매수 버튼 → 네이티브 주문 창(웹에서 열었다는 안내 포함). 주문 자체는 사용자가 눌러야 나간다
  await fromWeb({v: 1, type: 'openOrder', payload: {symbol: '000001', side: 'bid', price: 71_200}});
  expect(r.root.findAllByProps({testID: 'fromWebNotice'}).length).toBeGreaterThan(0);
  expect(r.root.findByProps({testID: 'orderPrice'}).props.children).toBe('71,200');
  expect(debugSink.recent().find(e => e.name === 'open_order_sheet')?.params).toEqual({symbol: '000001', side: 'bid', entry: 'web'});

  // 웹이 보낸 분석 이벤트는 분류표로 걸러 source=web으로 기록
  await fromWeb({v: 1, type: 'track', payload: {name: 'click_order_from_web', params: {symbol: '000001', side: 'bid', email: 'x@y'}}});
  const webEvent = debugSink.recent().find(e => e.name === 'click_order_from_web');
  expect(webEvent).toMatchObject({source: 'web', params: {symbol: '000001', side: 'bid'}});
  expect(webEvent!.params).not.toHaveProperty('email');

  // 더 새 프로토콜의 웹 화면 → unsupported
  await fromWeb({v: 1, type: 'hello', payload: {page: 'stock_info', protocol: 2}});
  expect(lastInjected()).toMatchObject({type: 'unsupported'});

  await ReactTestRenderer.act(async () => r.unmount());
});

test('settings: switching to Indonesian changes text and number grouping and is saved', async () => {
  const r = await renderSignedIn();
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'openSettings'}).props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'locale-id'}).props.onPress();
    await flush();
  });
  expect(getLocale()).toBe('id');
  expect(mockStore.get('app.locale')).toBe('id');
  expect(debugSink.recent().find(e => e.name === 'change_language')?.params).toEqual({from: 'ko', to: 'id'});

  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'back'}).props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'watch-000001'}).props.onPress();
    await flush();
  });
  // 인도네시아어: 탭 이름이 바뀌고 자릿수 구분은 마침표
  const texts = r.root.findAllByType(require('react-native').Text).map(n => [n.props.children].flat().join(''));
  expect(texts).toContain('Antrean');
  expect(texts).toContain('71.300');

  await ReactTestRenderer.act(async () => r.unmount());
});

test('bench: switching to the JS-routed mode taps every market message and renders from the JS book', async () => {
  const r = await renderSignedIn();
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'openSettings'}).props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'openBench'}).props.onPress();
  });
  const prices = () =>
    r.root
      .findByProps({testID: 'bench-book'})
      .findAllByType(require('react-native').Text)
      .map(n => [n.props.children].flat().join(''));
  // 기본은 C++ 직접 + pull(목 장부)
  expect(prices()).toContain('71,300');
  expect(NativeHogaCore.setMarketTap).not.toHaveBeenCalled();

  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'bench-mode-js'}).props.onPress();
    await flush();
  });
  expect(NativeHogaCore.setMarketTap).toHaveBeenLastCalledWith(true);
  expect(mockMarketListeners).toHaveLength(1);
  // 처음엔 HTTP 스냅샷(seq 100), 다음 delta는 JS 장부에 바로 반영
  expect(prices()).toContain('70,100');
  await ReactTestRenderer.act(async () => {
    mockMarketListeners[0]!('{"t":"delta","sym":"000001","seq":101,"ts":1,"side":"A","px":70200,"qty":9}');
  });
  expect(prices()).toContain('70,200');

  // 나가면 탭을 끈다
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'back'}).props.onPress();
  });
  expect(NativeHogaCore.setMarketTap).toHaveBeenLastCalledWith(false);
  expect(mockMarketListeners).toHaveLength(0);

  await ReactTestRenderer.act(async () => r.unmount());
});

test('OTP: an order that needs OTP asks for a code, verifies, and resends with the same key', async () => {
  const orderPosts: {key: string; stepUp?: string}[] = [];
  const base = globalThis.fetch as jest.Mock;
  globalThis.fetch = jest.fn(async (url: string, init?: {method?: string; headers?: Record<string, string>; body?: string}) => {
    if (url.endsWith('/orders') && init?.method === 'POST') {
      orderPosts.push({key: init.headers!['idempotency-key']!, stepUp: init.headers!['x-step-up']});
      if (!init.headers!['x-step-up']) return respond(403, {error: 'OTP_REQUIRED'});
      const body = JSON.parse(init.body!);
      return respond(200, {...body, key: init.headers!['idempotency-key'], orderId: 9, status: 'NEW', reject: 'NONE', filled: 0, resting: body.qty, fills: [], acceptedAt: 0, updatedAt: 0});
    }
    if (url.endsWith('/auth/otp/verify')) {
      return JSON.parse(init!.body!).code === '123456' ? respond(200, {stepUpToken: 'step-up-1', expiresIn: 600}) : respond(401, {error: 'OTP_INVALID'});
    }
    return base(url, init);
  }) as unknown as typeof fetch;

  const r = await renderSignedIn();
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'watch-000001'}).props.onPress();
    await flush();
  });
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'buyButton'}).props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'submitOrder'}).props.onPress();
    await flush();
  });
  expect(r.root.findByProps({testID: 'orderProgress'}).props.children).toBe('이 계정은 주문 전 OTP 인증이 필요합니다');
  // OTP를 기다리는 동안 원래 주문 버튼은 눌리지 않는다(같은 주문이 하나 더 시작되지 않게)
  expect(r.root.findByProps({testID: 'submitOrder'}).props.disabled).toBe(true);

  // 5자리까지는 보내지 않는다
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'otpCode'}).props.onChangeText('12345');
    await flush();
  });
  expect(r.root.findByProps({testID: 'otpSubmit'}).props.disabled).toBe(true);

  // 6자리가 되면 바로 확인(숫자 키패드에는 Return 키가 없다). 틀린 코드 → 오류, 주문은 다시 보내지 않음
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'otpCode'}).props.onChangeText('000000');
    await flush();
  });
  expect(r.root.findByProps({testID: 'otpError'})).toBeTruthy();
  expect(orderPosts).toHaveLength(1);

  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'otpCode'}).props.onChangeText('12-34 56'); // 숫자만 남긴다
    await flush();
    await flush();
  });
  expect(orderPosts).toEqual([{key: 'key-123', stepUp: undefined}, {key: 'key-123', stepUp: 'step-up-1'}]);
  expect(r.root.findByProps({testID: 'orderProgress'}).props.children).toBe('주문이 접수되었습니다');

  await ReactTestRenderer.act(async () => r.unmount());
});

test('OTP settings: enroll shows a QR and the key once, a code turns it on', async () => {
  const base = globalThis.fetch as jest.Mock;
  let enabled = false;
  globalThis.fetch = jest.fn(async (url: string, init?: {method?: string; body?: string}) => {
    if (url.endsWith('/auth/otp')) return respond(200, {enabled});
    if (url.endsWith('/auth/otp/enroll')) {
      return respond(200, {secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/Hoga%20MTS:u-demo?secret=JBSWY3DPEHPK3PXP&issuer=Hoga%20MTS'});
    }
    if (url.endsWith('/auth/otp/confirm')) {
      enabled = JSON.parse(init!.body!).code === '654321';
      return enabled ? respond(200, {enabled: true}) : respond(401, {error: 'OTP_INVALID'});
    }
    return base(url, init);
  }) as unknown as typeof fetch;

  const r = await renderSignedIn();
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'openSettings'}).props.onPress();
    await flush();
  });
  expect(r.root.findByProps({testID: 'otpStatus'}).props.children).toBe('사용 안 함');
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'otpEnroll'}).props.onPress();
    await flush();
  });
  expect(r.root.findByProps({testID: 'otpSecret'}).props.children).toBe('JBSW Y3DP EHPK 3PXP');
  // QR은 View 조각들로 그린다(검은 칸이 있어야 한다)
  expect(r.root.findByProps({testID: 'otpQr'}).findAll(n => (n.type as unknown) === 'View').length).toBeGreaterThan(20);
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'otpSettingsCode'}).props.onChangeText('654321');
  });
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'otpConfirm'}).props.onPress();
    await flush();
  });
  expect(r.root.findByProps({testID: 'otpStatus'}).props.children).toBe('사용 중 — 주문 전 10분마다 코드 확인');
  expect(r.root.findAllByProps({testID: 'otpSecret'})).toHaveLength(0); // 키는 다시 보여 주지 않는다

  await ReactTestRenderer.act(async () => r.unmount());
});

test('최소 버전보다 낮으면 업데이트 화면만, 점검 중이면 점검 화면', async () => {
  const base = (globalThis.fetch as jest.Mock).getMockImplementation()!;
  let config: {
    update: string;
    minVersion: string;
    latestVersion: string;
    storeUrl: string;
    maintenance: {active: boolean; until: number | null; message: string};
  } = {
    update: 'required',
    minVersion: '9.0.0',
    latestVersion: '9.0.0',
    storeUrl: 'https://apps.apple.com/',
    maintenance: {active: false, until: null, message: ''},
  };
  (globalThis.fetch as jest.Mock).mockImplementation(async (url: string) =>
    url.includes('/app/config') ? respond(200, config) : base(url),
  );
  let r: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    r = ReactTestRenderer.create(<App />);
    await flush();
    await flush();
  });
  expect(r!.root.findAllByProps({testID: 'forceUpdate'}).length).toBeGreaterThan(0);
  expect(r!.root.findAllByProps({testID: 'login'})).toHaveLength(0);

  config = {...config, update: 'none', maintenance: {active: true, until: Date.now() + 60_000, message: '점검 중'}};
  await ReactTestRenderer.act(async () => {
    r!.root.findByProps({testID: 'openStore'}); // 업데이트 화면에는 스토어 버튼
  });
  // 다시 읽게(포그라운드 복귀 등) → 점검 화면
  await ReactTestRenderer.act(async () => {
    r!.unmount();
    r = ReactTestRenderer.create(<App />);
    await flush();
    await flush();
  });
  expect(r!.root.findAllByProps({testID: 'maintenance'}).length).toBeGreaterThan(0);
  r!.unmount();
});

test('계좌 화면: 잔고·미체결을 보여 주고, 정정은 같은 주문 창을 정정 모드로 연다', async () => {
  const base = (globalThis.fetch as jest.Mock).getMockImplementation()!;
  const open = {
    key: 'order-key-1',
    userId: 'u-demo',
    symbol: '000001',
    side: 'bid',
    type: 'limit',
    price: 70_000,
    qty: 10,
    orderId: 7,
    status: 'NEW',
    reject: 'NONE',
    filled: 0,
    resting: 10,
    fills: [],
    acceptedAt: 0,
    updatedAt: 0,
  };
  (globalThis.fetch as jest.Mock).mockImplementation(async (url: string) => {
    if (url.endsWith('/account'))
      return respond(200, {
        accountNo: '5001-10-000001',
        cash: 50_000_000,
        reservedCash: 700_000,
        availableCash: 49_300_000,
        realizedPnl: 0,
        positions: [
          {symbol: '000001', name: '가상전자', qty: 100, sellable: 100, avgPrice: 69_800, lastPrice: 71_200, value: 7_120_000, pnl: 140_000, pnlRate: 2.01},
        ],
        totals: {purchase: 6_980_000, value: 7_120_000, pnl: 140_000, pnlRate: 2.01, equity: 57_120_000},
      });
    if (url.includes('/orders?status=open')) return respond(200, [open]);
    if (url.includes('/account/orderable')) return respond(200, {availableCash: 49_300_000, sellableQty: 100, maxQty: 704, unitPrice: 70_000});
    return base(url);
  });
  const r = await renderSignedIn();
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'openAccount'}).props.onPress();
    await flush();
    await flush();
  });
  expect(r.root.findAllByProps({testID: 'position-000001'}).length).toBeGreaterThan(0);

  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'accountTab-open'}).props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    r.root.findByProps({testID: 'amend-order-key-1'}).props.onPress();
    await flush();
  });
  // 정정 모드: 매수/매도는 바꿀 수 없고 수량은 잔량으로 시작
  expect(r.root.findByProps({testID: 'side-ask'}).props.disabled).toBe(true);
  expect(r.root.findByProps({testID: 'orderQty'}).props.value).toBe('10');
  // 주문가능 조회(250ms 모아서)가 끝난 뒤 정리
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 350));
  });
  expect(r.root.findByProps({testID: 'orderable'}).props.children).toContain('10');
  await ReactTestRenderer.act(async () => r.unmount());
});
