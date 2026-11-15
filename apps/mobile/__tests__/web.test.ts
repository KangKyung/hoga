// 앱 tsconfig에는 Node 타입이 없다. 테스트(Jest = Node)에서 파일만 읽으면 되므로 필요한 만큼만 선언한다.
declare const __dirname: string;
declare function require(name: 'fs'): {readFileSync(file: string, encoding: 'utf8'): string};
const fs = require('fs');
const path = {join: (...parts: string[]) => parts.join('/')};

import taxonomy from '../../../shared/analytics/events.json';
import {validateEvent} from '../src/analytics/analytics';
import {formatNumber, getI18nState, LOCALES, refreshFromServer, resetI18nForTest, setLocale, t} from '../src/i18n';
import {isAllowedUrl, MAX_MESSAGE_BYTES, parseWebMessage, RateLimiter, toWebScript} from '../src/web/bridge';

const ORIGINS = ['http://localhost:8080'];
const PAGE = 'http://localhost:8080/web/stock/?symbol=000001';
const msg = (envelope: unknown) => JSON.stringify(envelope);

describe('bridge: messages from the web are untrusted', () => {
  test('accepts a valid openOrder from our origin', () => {
    expect(parseWebMessage(msg({v: 1, type: 'openOrder', payload: {symbol: '000001', side: 'ask', price: 71_000}}), PAGE, ORIGINS)).toEqual({
      ok: true,
      message: {type: 'openOrder', payload: {symbol: '000001', side: 'ask', price: 71_000}},
    });
  });

  test.each([
    ['other origin', msg({v: 1, type: 'hello', payload: {page: 'x', protocol: 1}}), 'https://evil.example/', 'origin'],
    ['look-alike host', msg({v: 1, type: 'hello', payload: {page: 'x', protocol: 1}}), 'http://localhost:8080.evil.example/', 'origin'],
    ['about:blank', msg({v: 1, type: 'hello', payload: {page: 'x', protocol: 1}}), 'about:blank', 'origin'],
    ['not JSON', '{oops', PAGE, 'schema'],
    ['wrong version', msg({v: 2, type: 'hello', payload: {page: 'x', protocol: 1}}), PAGE, 'version'],
    ['unknown type', msg({v: 1, type: 'placeOrder', payload: {}}), PAGE, 'schema'],
    ['bad symbol', msg({v: 1, type: 'openOrder', payload: {symbol: '../1', side: 'bid'}}), PAGE, 'schema'],
    ['bad side', msg({v: 1, type: 'openOrder', payload: {symbol: '000001', side: 'buy'}}), PAGE, 'schema'],
    ['fractional price', msg({v: 1, type: 'openOrder', payload: {symbol: '000001', side: 'bid', price: 1.5}}), PAGE, 'schema'],
    ['negative price', msg({v: 1, type: 'openOrder', payload: {symbol: '000001', side: 'bid', price: -100}}), PAGE, 'schema'],
    ['bad event name', msg({v: 1, type: 'track', payload: {name: 'Bad Name!', params: {}}}), PAGE, 'schema'],
    ['too large', msg({v: 1, type: 'track', payload: {name: 'x', params: {pad: 'a'.repeat(MAX_MESSAGE_BYTES)}}}), PAGE, 'size'],
  ])('rejects %s', (_label, raw, url, reason) => {
    expect(parseWebMessage(raw, url, ORIGINS)).toMatchObject({ok: false, reason});
  });

  test('navigation allow-list compares the whole origin', () => {
    expect(isAllowedUrl('http://localhost:8080/web/notices/#!/n-104', ORIGINS)).toBe(true);
    expect(isAllowedUrl('http://LOCALHOST:8080/web/', ORIGINS)).toBe(true);
    expect(isAllowedUrl('http://localhost:8081/', ORIGINS)).toBe(false);
    expect(isAllowedUrl('https://localhost:8080/', ORIGINS)).toBe(false);
    // eslint-disable-next-line no-script-url -- 막혀야 하는 주소를 일부러 넣는다
    expect(isAllowedUrl('javascript:alert(1)', ORIGINS)).toBe(false);
    expect(isAllowedUrl('file:///etc/hosts', ORIGINS)).toBe(false);
  });

  test('app → web script cannot break out of the string', () => {
    const script = toWebScript({type: 'locale', payload: {locale: `"); alert(1); ("`}});
    const arg = /receive\((".*")\); true;$/.exec(script)![1]!;
    expect(JSON.parse(JSON.parse(arg))).toEqual({v: 1, type: 'locale', payload: {locale: `"); alert(1); ("`}});
  });

  test('rate limiter allows a burst then refills over time', () => {
    let now = 0;
    const limiter = new RateLimiter(5, () => now);
    expect(Array.from({length: 6}, () => limiter.take())).toEqual([true, true, true, true, true, false]);
    now += 400; // 0.4초 → 2개 충전
    expect([limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, false]);
  });
});

describe('i18n', () => {
  beforeEach(() => resetI18nForTest());

  test('every locale has the same keys and placeholders as ko', () => {
    const dir = path.join(__dirname, '../../../shared/i18n');
    const load = (l: string) => JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8')) as Record<string, string>;
    const ko = load('ko');
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const locale of LOCALES) {
      const messages = load(locale);
      expect(Object.keys(messages).sort()).toEqual(Object.keys(ko).sort());
      for (const key of Object.keys(ko)) expect([locale, key, placeholders(messages[key]!)]).toEqual([locale, key, placeholders(ko[key]!)]);
    }
  });

  test('interpolates and falls back to the key', () => {
    expect(t('common.shares', {n: '1,000'})).toBe('1,000주');
    setLocale('en');
    expect(t('order.retrying', {attempt: 2})).toBe('Resending with the same order ID (attempt 2)');
    expect(t('no.such.key')).toBe('no.such.key');
  });

  test('number grouping follows the language', () => {
    expect(formatNumber(71_200)).toBe('71,200');
    setLocale('id');
    expect(formatNumber(71_200)).toBe('71.200');
    setLocale('th');
    expect(formatNumber(71_200)).toBe('71,200');
  });

  test('server translations override bundled ones; missing keys fall back; 304 keeps them', async () => {
    const fetcher = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({lang: 'ko', version: 'abc123', messages: {'watchlist.title': '내 종목'}}),
    }));
    expect(await refreshFromServer('http://x', fetcher as unknown as typeof fetch)).toBe('updated');
    expect(t('watchlist.title')).toBe('내 종목');
    expect(t('common.buy')).toBe('매수'); // 서버에 없는 키는 내장본
    expect(getI18nState().remoteVersion).toBe('abc123');

    const notModified = jest.fn(async () => ({ok: false, status: 304, json: async () => ({})}));
    expect(await refreshFromServer('http://x', notModified as unknown as typeof fetch)).toBe('unchanged');
    expect((notModified.mock.calls[0] as unknown[])[1]).toEqual({headers: {'If-None-Match': '"abc123"'}});
    expect(t('watchlist.title')).toBe('내 종목');
  });

  test('bad or failed server responses keep the bundled text', async () => {
    const wrongLang = jest.fn(async () => ({ok: true, status: 200, json: async () => ({lang: 'en', version: 'v', messages: {}})}));
    expect(await refreshFromServer('http://x', wrongLang as unknown as typeof fetch)).toBe('failed');
    const offline = jest.fn(async () => {
      throw new Error('offline');
    });
    expect(await refreshFromServer('http://x', offline as unknown as typeof fetch)).toBe('failed');
    expect(t('watchlist.title')).toBe('관심종목');
  });
});

describe('analytics taxonomy', () => {
  test('event names follow GA4 rules', () => {
    for (const name of Object.keys(taxonomy.events)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
      expect(name.startsWith('firebase_') || name.startsWith('google_') || name.startsWith('ga_')).toBe(false);
    }
  });

  test('validateEvent catches unknown events, params and wrong source', () => {
    expect(validateEvent('switch_quote_tab', {symbol: '000001', tab: 'chart'}, 'app')).toEqual([]);
    expect(validateEvent('nope', {}, 'app')).toEqual(['unknown event: nope']);
    expect(validateEvent('switch_quote_tab', {amount: 1}, 'app')).toEqual(['switch_quote_tab: unknown param amount']);
    expect(validateEvent('login', {}, 'web')).toEqual(['login is not sent from web']);
  });

  test('every event the web pages send is declared for the web', () => {
    const webDir = path.join(__dirname, '../../../server/web');
    const sources = ['stock/stock.js', 'notices/notices.js'].map(f => fs.readFileSync(path.join(webDir, f), 'utf8')).join('\n');
    const sent = [...sources.matchAll(/analytics\.track\('([a-z_]+)'/g)].map(m => m[1]!);
    expect(sent.length).toBeGreaterThan(3);
    for (const name of sent) {
      const spec = (taxonomy.events as Record<string, {source: string[]}>)[name];
      expect([name, spec?.source.includes('web')]).toEqual([name, true]);
    }
  });
});
