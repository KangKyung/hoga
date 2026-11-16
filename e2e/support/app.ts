/**
 * 두 플랫폼 공용 도우미. 화면 요소는 RN testID 하나로 찾는다.
 * - iOS: testID → accessibilityIdentifier → `~id`
 * - Android: testID → resource-id(RN이 view id로 넣음) → UiSelector
 */
import {createHmac} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const isIOS = () => driver.isIOS;

/** 앱과 같은 번역 파일로 기대 문구를 만든다(문구를 고쳐도 테스트는 그대로) */
const ko: Record<string, string> = JSON.parse(readFileSync(path.join(here, '../../shared/i18n/ko.json'), 'utf8'));
export function t(key: string, params: Record<string, string | number> = {}): string {
  const template = ko[key];
  if (template === undefined) throw new Error(`unknown i18n key ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

export function byId(id: string) {
  return isIOS() ? $(`~${id}`) : $(`android=new UiSelector().resourceId("${id}")`);
}

export async function tap(id: string, timeout = 15_000) {
  const el = byId(id);
  await el.waitForDisplayed({timeout});
  await el.click();
}

/** 스크롤 안쪽 아래에 있는 요소가 보일 때까지 위로 쓸어 올린다(W3C 포인터 동작이라 두 플랫폼 같음) */
export async function scrollTo(id: string, maxSwipes = 8) {
  const el = byId(id);
  const {width, height} = await driver.getWindowSize();
  for (let i = 0; i < maxSwipes; i++) {
    if (await el.isDisplayed().catch(() => false)) return;
    await driver
      .action('pointer', {parameters: {pointerType: 'touch'}})
      .move({x: Math.round(width / 2), y: Math.round(height * 0.7)})
      .down()
      .move({x: Math.round(width / 2), y: Math.round(height * 0.3), duration: 300})
      .up()
      .perform();
    await browser.pause(300);
  }
  await el.waitForDisplayed({timeout: 1_000});
}

export async function textOf(id: string): Promise<string> {
  const el = byId(id);
  await el.waitForDisplayed();
  // iOS는 Text의 label, Android는 TextView의 text
  return (await el.getText()).trim();
}

export async function exists(id: string, timeout = 1_500): Promise<boolean> {
  return byId(id)
    .waitForDisplayed({timeout})
    .then(() => true)
    .catch(() => false);
}

/** 조건이 맞을 때까지 글자를 다시 읽는다 */
export async function waitForText(id: string, ok: (text: string) => boolean, timeout = 15_000, what = id): Promise<string> {
  let last = '';
  try {
    await browser.waitUntil(
      async () => {
        last = await textOf(id).catch(() => '');
        return ok(last);
      },
      {timeout, interval: 300},
    );
  } catch {
    // 실패한 순간의 요소 트리(Android는 FLAG_SECURE라 화면 캡처 대신 이것이 단서)
    const dir = path.join(here, '..', 'reports', driver.isIOS ? 'ios' : 'android');
    mkdirSync(dir, {recursive: true});
    const xml = await browser.getPageSource().catch(() => '');
    writeFileSync(path.join(dir, `waitfail-${what.replace(/[^\w-]+/g, '_')}.xml`), xml);
    throw new Error(`${what}: 마지막 값 "${last}"`);
  }
  return last;
}

// ---- 서버 ----

export const SERVER = process.env.HOGA_SERVER ?? 'http://localhost:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'hoga-admin-dev-token';

export async function admin(method: 'GET' | 'PUT' | 'POST', route: string, body?: unknown) {
  const res = await fetch(`${SERVER}/admin/api${route}`, {
    method,
    headers: {'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`admin ${route}: ${res.status}`);
  return res.json();
}

export const resetFaults = () => admin('PUT', '/faults', {dropSeqRate: 0, orderDelayMs: 0, simIntervalMs: 100, simBurst: 1});

// ---- 앱 흐름 ----

/**
 * iOS "암호를 저장하겠습니까?" 같은 시스템 창. 앱의 창이 아니라 앱이 고를 수 없으므로 테스트가 닫는다.
 * 기기 언어와 관계없이 "저장하지 않음" 쪽(왼쪽, 첫 번째 버튼)을 누른다.
 */
export async function dismissSystemPrompts(timeout = 4_000) {
  if (!isIOS()) {
    // Android 17 로컬 네트워크(근처 기기) 권한: adb reverse로 localhost에 붙으므로 필요 없다 → 거부
    const deny = $('android=new UiSelector().resourceIdMatches("com.android.permissioncontroller:id/permission_deny.*")');
    if (await deny.isDisplayed().catch(() => false)) await deny.click();
    return;
  }
  if (await exists('watch-000001', timeout)) return;
  const buttons = await driver.execute('mobile: alert', {action: 'getButtons'}).catch(() => null);
  if (Array.isArray(buttons) && buttons.length) {
    await driver.execute('mobile: alert', {action: 'dismiss'}).catch(() => {});
    return;
  }
  // 암호 저장 창은 다른 프로세스(AutoFill)가 띄워 앱의 요소 트리에 없다. 화면 비율 위치로 왼쪽 버튼을 누른다.
  const {width, height} = await driver.getWindowSize();
  await driver.execute('mobile: tap', {x: Math.round(width * 0.315), y: Math.round(height * 0.614)});
}

/** 보이면 누르고, 없거나 그새 사라졌으면 넘어간다 */
export async function tapIfPresent(id: string, timeout = 500) {
  if (await exists(id, timeout)) await byId(id).click().catch(() => {});
}

/** 뒤로 가기를 눌러 관심종목(또는 로그인)까지. 화면 전환 중이면 다음 바퀴에 다시 본다 */
export async function goHome() {
  for (let i = 0; i < 4; i++) {
    if (!(await exists('back', 800))) return;
    await byId('back').click().catch(() => {});
    await browser.pause(400);
  }
}

/** 어떤 화면에서 시작하든 로그인 → 관심종목 → 언어 ko 까지 맞춘다 */
export async function signInFresh(user: {username: string; password: string} = {username: 'demo', password: 'hoga-demo-1234'}) {
  await dismissSystemPrompts(1_500);
  // 이전 실행이 남긴 화면에서 관심종목까지 돌아온다(주문 창이 위에 떠 있으면 먼저 닫는다)
  await tapIfPresent('otpCancel');
  await tapIfPresent('orderDone');
  await tapIfPresent('closeOrder');
  await goHome();
  await tapIfPresent('logout', 1_500);
  await tapIfPresent('otherAccount', 1_000);

  const password = byId('password');
  await browser.waitUntil(
    async () => {
      if (await password.isDisplayed().catch(() => false)) return true;
      await dismissSystemPrompts(300);
      return false;
    },
    {timeout: 30_000, interval: 500, timeoutMsg: 'login screen did not appear'},
  );
  const username = byId('username');
  if ((await username.getText().catch(() => '')) !== user.username) await username.setValue(user.username);
  await password.setValue(user.password);
  if (await exists('login', 1_000)) {
    await tap('login');
  } else if (isIOS()) {
    // 키보드가 버튼을 가리면 Return으로 제출(앱이 onSubmitEditing으로 로그인)
    await password.addValue('\n');
  } else {
    await driver.hideKeyboard();
    await tap('login');
  }
  await byId('watch-000001').waitForDisplayed({timeout: 20_000}).catch(() => {});
  // 암호 저장 창은 화면 전환 뒤 조금 늦게 뜬다
  if (isIOS()) await browser.pause(2_000);
  await dismissSystemPrompts();
  await byId('watch-000001').waitForDisplayed({timeout: 20_000});

  await browser.waitUntil(
    async () => {
      if (await exists('locale-ko', 1_000)) return true;
      await dismissSystemPrompts(500);
      await byId('openSettings').click().catch(() => {});
      return false;
    },
    {timeout: 20_000, interval: 200, timeoutMsg: 'settings did not open'},
  );
  await tap('locale-ko');
  await tap('back');
  await byId('watch-000001').waitForDisplayed();
}

// ---- OTP(시험이 인증 앱 역할) ----


function base32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP(30초, 6자리). offset으로 다음 구간 코드도 만든다(같은 코드 재사용 금지 대응) */
export function totp(secret: string, offset = 0, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000) + offset));
  const mac = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export async function api(path: string, body: unknown, token?: string) {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})},
    body: JSON.stringify(body),
  });
  return {status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, string>};
}
