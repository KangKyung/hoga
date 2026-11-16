import {compareVersions} from '../src/appgate/appConfig';
import {MAX_ACTIVE, SubscriptionManager, UNSUB_DELAY_MS} from '../src/market/subscriptions';
import {parseWebMessage} from '../src/web/bridge';

jest.mock('../src/native/hogaCore', () => ({hogaCore: {subscribe: jest.fn(), unsubscribe: jest.fn()}}));
jest.mock('../src/api/http', () => ({request: jest.fn(), onMaintenance: () => () => {}}));
jest.mock('../src/i18n', () => ({getLocale: () => 'ko'}));

function setup() {
  let now = 0;
  const calls: Array<['sub' | 'unsub', string[]]> = [];
  const m = new SubscriptionManager({
    subscribe: codes => calls.push(['sub', codes]),
    unsubscribe: codes => calls.push(['unsub', codes]),
    now: () => now,
    setTimer: () => 1, // 테스트는 flush()를 직접 부른다
    clearTimer: () => {},
  });
  return {m, calls, advance: (ms: number) => (now += ms)};
}

describe('SubscriptionManager(보이는 종목만 구독)', () => {
  test('같은 종목을 여러 화면이 잡아도 한 번만 구독하고, 마지막이 놓은 뒤 잠시 후 해제', () => {
    const {m, calls, advance} = setup();
    const a = m.acquire(['000001', '000002']);
    const b = m.acquire(['000001']);
    m.flush();
    expect(calls).toEqual([['sub', ['000001', '000002']]]);
    a();
    m.flush();
    expect(calls).toHaveLength(1); // 000001은 b가 아직 잡고 있고, 000002는 지연 중
    advance(UNSUB_DELAY_MS);
    m.flush();
    expect(calls.at(-1)).toEqual(['unsub', ['000002']]);
    b();
    advance(UNSUB_DELAY_MS);
    m.flush();
    expect(calls.at(-1)).toEqual(['unsub', ['000001']]);
    expect(m.activeCount()).toBe(0);
  });

  test('스크롤로 잠깐 벗어났다 돌아오면 다시 구독하지 않는다', () => {
    const {m, calls, advance} = setup();
    const release = m.acquire(['000010']);
    m.flush();
    release();
    advance(UNSUB_DELAY_MS / 2);
    m.acquire(['000010']);
    advance(UNSUB_DELAY_MS);
    m.flush();
    expect(calls).toEqual([['sub', ['000010']]]);
  });

  test('상한을 넘으면 놓은 종목부터 바로 해제하고, 그래도 넘으면 보류', () => {
    const {m, calls} = setup();
    const codes = (from: number, n: number) => Array.from({length: n}, (_, i) => String(from + i).padStart(6, '0'));
    const first = m.acquire(codes(1, MAX_ACTIVE));
    m.flush();
    first();
    m.acquire(codes(100, 10));
    m.flush();
    expect(m.activeCount()).toBeLessThanOrEqual(MAX_ACTIVE);
    expect(calls.some(([kind, list]) => kind === 'unsub' && list.length === 10)).toBe(true);
    // 전부 잡혀 있으면 더 늘리지 않는다
    m.acquire(codes(200, MAX_ACTIVE));
    m.flush();
    expect(m.activeCount()).toBe(MAX_ACTIVE);
  });

  test('다시 연결하면 지금 필요한 종목만 처음부터 구독', () => {
    const {m, calls} = setup();
    m.acquire(['000001']);
    const gone = m.acquire(['000002']);
    m.flush();
    gone();
    m.resubscribe();
    expect(calls.at(-1)).toEqual(['sub', ['000001']]);
  });
});

test('버전 비교(semver 숫자)', () => {
  expect(compareVersions('0.8.0', '0.10.0')).toBe(-1);
  expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  expect(compareVersions('0.8.0', '0.8.0')).toBe(0);
});

describe('계좌 개설 브리지 메시지', () => {
  const url = 'http://localhost:8080/web/account-open/';
  const send = (type: string, payload: unknown) => parseWebMessage(JSON.stringify({v: 1, type, payload}), url, ['http://localhost:8080']);
  const id = '2b8f6c1e-9d3a-4c5b-8e7f-0a1b2c3d4e5f';
  const token = 'A'.repeat(43);

  test('형식이 맞는 신청서만 저장 요청으로 받는다', () => {
    expect(send('saveDraft', {id, token})).toEqual({ok: true, message: {type: 'saveDraft', payload: {id, token}}});
    expect(send('saveDraft', {id: 'not-a-uuid', token}).ok).toBe(false);
    expect(send('saveDraft', {id, token: 'short'}).ok).toBe(false);
  });

  test('완료 메시지의 아이디 형식 검사, 촬영 요청은 내용이 없다', () => {
    expect(send('accountOpened', {username: 'newbie01'}).ok).toBe(true);
    expect(send('accountOpened', {username: 'Robert"); drop'}).ok).toBe(false);
    expect(send('captureIdCard', {anything: 1})).toEqual({ok: true, message: {type: 'captureIdCard', payload: {}}});
  });
});
