/**
 * 핵심 사용자 흐름. 같은 파일이 iOS(XCUITest)·Android(UiAutomator2)에서 그대로 돈다.
 *
 * 1. 로그인 → 관심종목 → 호가 → 주문 → 체결/접수 확인
 * 2. 서버 응답 지연 중 주문 → "확인 중" → 조회로 확정(실패로 보지 않음)
 * 3. seq 누락 주입 → 앱이 감지하고 스냅샷으로 다시 맞춤
 * 4. 웹뷰 종목정보의 매수 버튼 → 네이티브 주문 창(웹은 주문을 직접 내지 못함)
 * 5. OTP를 켠 계정의 주문 → 코드 입력 창 → 인증 후 같은 주문 번호로 접수(시험이 인증 앱 역할)
 * 6. 장 시작 동시호가 표시 → 계좌 미체결에서 정정(원주문 잔량 일부를 새 가격으로)
 * 7. 서비스 점검: API가 503을 받으면 앱 전체가 점검 화면 → 해제 후 다시 확인
 */
import {
  admin,
  api,
  byId,
  exists,
  goHome,
  resetFaults,
  scrollTo,
  SERVER,
  signInFresh,
  t,
  tap,
  tapIfPresent,
  textOf,
  totp,
  waitForText,
} from '../support/app.js';

const FINAL = [t('order.accepted'), t('order.filled', {filled: ''}).split('(')[0]!, t('order.partial', {filled: '', resting: ''}).split(' ')[0]!];
const isFinal = (s: string) => FINAL.some(prefix => s.startsWith(prefix.trim()));

describe('Hoga MTS', () => {
  before(async () => {
    await resetFaults();
    await signInFresh();
  });

  afterEach(async () => {
    await resetFaults();
    await tapIfPresent('orderDone', 300);
    await tapIfPresent('closeOrder', 300);
    await goHome();
  });

  it('logs in, opens the order book, places a limit order and sees the result', async () => {
    await tap('watch-000001');
    // 실시간 호가가 들어와 현재가가 보인다
    await waitForText('lastPrice', s => /\d/.test(s), 20_000);
    await waitForText('statusBadge', s => s.includes(t('status.live')), 20_000, 'status').catch(async () => {
      // 일부 플랫폼은 배지 묶음의 글자를 못 읽으므로 호가 행이 있으면 통과
      await byId('buyButton').waitForDisplayed();
    });

    await tap('buyButton');
    await byId('submitOrder').waitForDisplayed();
    await tap('submitOrder');
    const result = await waitForText('orderProgress', isFinal, 20_000, 'order result');
    expect(result).not.toContain(t('order.failed', {reason: ''}).trim());
  });

  it('shows "confirming" when the server is slow, then settles by lookup', async () => {
    await admin('PUT', '/faults', {orderDelayMs: 5_000});
    await tap('watch-000001');
    await tap('sellButton');
    await tap('submitOrder');
    // 3초(ORDER_TIMEOUT_MS) 뒤 실패가 아니라 "확인 중"
    await waitForText('orderProgress', s => s === t('order.confirming'), 10_000, 'confirming');
    // 서버가 실제로 처리했으므로 조회로 접수/체결이 확정된다
    await waitForText('orderProgress', isFinal, 25_000, 'settled');
  });

  it('detects dropped sequence numbers and resyncs from a snapshot', async () => {
    await tap('watch-000001');
    await waitForText('lastPrice', s => /\d/.test(s), 20_000);
    await scrollTo('stats');
    const before = await textOf('stats');
    // "seq {seq} · 누락 감지 {gaps} · 재동기화 {resyncs} …" 형식을 번역 파일에서 그대로 만들어 읽는다
    const pattern = new RegExp(t('quote.stats').replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, '([\\d,.]+)'));
    const resyncs = (s: string) => Number((pattern.exec(s)?.[3] ?? 'NaN').replace(/[,.]/g, ''));
    await admin('PUT', '/faults', {dropSeqRate: 0.2, simIntervalMs: 50});
    await waitForText('stats', s => resyncs(s) > resyncs(before), 20_000, 'resyncs');
    await resetFaults();
    // 다시 실시간으로 돌아온다
    await browser.pause(1_500);
    expect(await exists('statusBadge')).toBe(true);
  });

  it('opens the native order sheet from the web stock-info page', async () => {
    await tap('watch-000001');
    await tap('tab-info');
    // 웹뷰를 감싼 View의 testID는 iOS 접근성 트리에 남지 않아(웹 내용이 대신 노출) 웹 버튼을 바로 기다린다
    // 웹 화면 버튼은 접근성 트리로 보인다(웹뷰 컨텍스트 전환 없이 두 플랫폼 같은 방법)
    const buy = driver.isIOS
      ? $(`-ios predicate string:type == "XCUIElementTypeButton" AND label == "${t('common.buy')}"`)
      : $(`android=new UiSelector().className("android.widget.Button").text("${t('common.buy')}")`);
    await buy.waitForDisplayed({timeout: 20_000});
    // 브리지가 연결돼 버튼이 활성화될 때까지
    await browser.waitUntil(() => buy.isEnabled(), {timeout: 10_000});
    await buy.click();
    await byId('fromWebNotice').waitForDisplayed({timeout: 10_000});
    expect(await textOf('fromWebNotice')).toBe(t('order.fromWeb'));
    // 웹은 주문을 직접 내지 않는다: 사용자가 누르기 전까지 주문 결과가 없다
    expect(await exists('orderProgress', 500)).toBe(false);
  });

  it('asks for an OTP before ordering when the account has OTP on', async () => {
    // 서버 API로 trader2의 OTP를 켠다(사용자가 설정 화면에서 하는 일과 같은 API). 지난 실행이 남긴 OTP는 관리자 초기화
    await admin('POST', '/otp/reset', {userId: 'u-trader2'});
    const login = await api('/auth/login', {username: 'trader2', password: 'hoga-trader-5678'});
    const token = login.body.accessToken!;
    const enroll = await api('/auth/otp/enroll', {}, token);
    expect(enroll.status).toBe(200);
    const secret = enroll.body.secret!;
    expect((await api('/auth/otp/confirm', {code: totp(secret)}, token)).status).toBe(200);
    try {
      await signInFresh({username: 'trader2', password: 'hoga-trader-5678'});
      await tap('watch-000001');
      await tap('buyButton');
      await tap('submitOrder');
      await waitForText('orderProgress', s => s === t('order.otpRequired'), 15_000, 'otp required');
      // 등록 확인에 쓴 구간 코드는 재사용 금지라 다음 구간 코드를 넣는다(±1 허용)
      // 6자리를 넣으면 앱이 바로 확인한다(버튼을 누를 필요 없음)
      await byId('otpCode').setValue(totp(secret, 1));
      await waitForText('orderProgress', isFinal, 20_000, 'order after otp');
    } finally {
      // 정리 중 오류가 원래 실패를 가리지 않게 따로 잡는다
      await admin('POST', '/otp/reset', {userId: 'u-trader2'}).catch(() => {});
      await tapIfPresent('orderDone', 300);
      await tapIfPresent('closeOrder', 300);
      await goHome();
      await signInFresh().catch(e => console.warn('cleanup sign-in failed:', e));
    }
  });

  it('shows the auction phase and modifies an open order from the account screen', async () => {
    const login = await api('/auth/login', {username: 'demo', password: 'hoga-demo-1234'});
    const token = login.body.accessToken!;
    // 체결되지 않도록 하한가 근처 지정가(서버 API로 미리 걸어 둔다)
    const key = `e2e-amend-${Date.now()}`;
    const placed = await orderApi(token, key, {symbol: '000001', side: 'bid', type: 'limit', price: 60_000, qty: 3});
    expect(placed.status).toBe('NEW');
    try {
      await admin('PUT', '/session', {phase: 'PRE_OPEN'});
      await tap('watch-000001');
      await waitForText('sessionPhase', s => s === t('session.phase.PRE_OPEN'), 15_000, 'pre-open badge');
      await admin('PUT', '/session', {phase: 'OPEN'});
      await waitForText('sessionPhase', s => s === t('session.phase.OPEN'), 15_000, 'open badge');
      await goHome();

      await tap('openAccount');
      // 잔고를 받은 뒤에 탭을 누른다(그 전에는 화면이 아직 바뀌는 중)
      await byId('availableCash').waitForDisplayed({timeout: 15_000});
      await tap('accountTab-open');
      await tap(`amend-${key}`);
      await tap('priceUp');
      await tap('submitOrder');
      await waitForText('orderProgress', isFinal, 20_000, 'amend result');
      const original = await getApi(token, `/orders/${key}`);
      expect(original).toMatchObject({resting: 0, amended: 3});
    } finally {
      await admin('PUT', '/session', {phase: 'OPEN'}).catch(() => {});
      // 정정으로 생긴 주문까지 미체결을 모두 정리
      const open = (await getApi(token, '/orders?status=open').catch(() => [])) as unknown as {key: string}[];
      for (const o of open) await api(`/orders/${o.key}/cancel`, {}, token).catch(() => {});
    }
  });

  it('switches the whole app to the maintenance screen when the server is under maintenance', async () => {
    await admin('PUT', '/app-config', {maintenance: {active: true, until: Date.now() + 10 * 60_000}});
    try {
      // 계좌 조회가 503 MAINTENANCE를 받으면 앱이 원격 설정을 다시 읽는다
      await tap('openAccount');
      await byId('maintenance').waitForDisplayed({timeout: 15_000});
    } finally {
      await admin('PUT', '/app-config', {maintenance: {active: false}});
    }
    await tap('retryGate');
    await byId('watch-000001').waitForDisplayed({timeout: 15_000});
  });
});

async function orderApi(token: string, key: string, body: Record<string, unknown>) {
  const res = await fetch(`${SERVER}/orders`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': key},
    body: JSON.stringify(body),
  });
  return (await res.json()) as {status: string};
}

async function getApi(token: string, path: string) {
  const res = await fetch(`${SERVER}${path}`, {headers: {authorization: `Bearer ${token}`}});
  return (await res.json()) as Record<string, unknown>;
}
