import { afterEach, describe, expect, it } from 'vitest';

import { createServer, type HogaServer } from '../src/app.js';
import { TEST_OPTIONS } from './fixtures.js';
import { loadConfig } from '../src/config.js';

const servers: HogaServer[] = [];
const ADMIN = 'test-admin-token-123';

async function start(env: Record<string, string> = {}) {
  const server = createServer(
    loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', SIM_INTERVAL_MS: '0', ADMIN_TOKEN: ADMIN, ...env }), TEST_OPTIONS);
  await server.start();
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

const admin = (server: HogaServer, method: string, url: string, body?: unknown, token = ADMIN) =>
  server.app.inject({ method: method as 'GET', url, headers: { 'x-admin-token': token }, payload: body as object });

describe('web pages', () => {
  it('serves the pages with a strict CSP and no-cache HTML', async () => {
    const server = await start();
    for (const url of ['/web/stock/', '/web/notices/', '/admin/']) {
      const res = await server.app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['cache-control']).toBe('no-cache');
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).toContain("frame-ancestors 'none'");
      // 인라인 스크립트가 없어야 CSP 아래에서 동작한다
      expect(res.body).not.toMatch(/<script>(?!<\/script>)/);
      expect(res.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    }
  });

  it('keeps the security headers on percent-encoded paths', async () => {
    const server = await start();
    for (const url of ['/%77eb/stock/index.html', '/%61dmin/index.html', '/web/stock/%69ndex.html']) {
      const res = await server.app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
    // HTML이 아닌 정적 파일도 /web/ 아래면 nosniff
    const js = await server.app.inject({ url: '/%77eb/stock/stock.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['x-content-type-options']).toBe('nosniff');
  });

  it('allows the GTM host only when a container is configured', async () => {
    const plain = await start();
    expect((await plain.app.inject({ url: '/web-config.js' })).body).toContain('"gtmContainerId":null');
    expect((await plain.app.inject({ url: '/web/stock/' })).headers['content-security-policy']).not.toContain('googletagmanager');

    const gtm = await start({ GTM_CONTAINER_ID: 'GTM-TEST123' });
    expect((await gtm.app.inject({ url: '/web-config.js' })).body).toContain('"gtmContainerId":"GTM-TEST123"');
    expect((await gtm.app.inject({ url: '/web/stock/' })).headers['content-security-policy']).toContain(
      'https://www.googletagmanager.com',
    );
  });

  it('exposes only the minified AngularJS files', async () => {
    const server = await start();
    expect((await server.app.inject({ url: '/vendor/angular/angular.min.js' })).statusCode).toBe(200);
    expect((await server.app.inject({ url: '/vendor/angular/package.json' })).statusCode).toBe(404);
    expect((await server.app.inject({ url: '/vendor/angular/../../package.json' })).statusCode).toBe(404);
  });
});

describe('translations', () => {
  it('returns the shared translation with a version and supports 304', async () => {
    const server = await start();
    const res = await server.app.inject({ url: '/i18n/th' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { lang: string; version: string; messages: Record<string, string> };
    expect(body.lang).toBe('th');
    expect(body.version).toMatch(/^[0-9a-f]{12}$/);
    expect(body.messages['common.buy']).toBe('ซื้อ');
    expect(res.headers.etag).toBe(`"${body.version}"`);

    const again = await server.app.inject({ url: '/i18n/th', headers: { 'if-none-match': `"${body.version}"` } });
    expect(again.statusCode).toBe(304);
    expect((await server.app.inject({ url: '/i18n/xx' })).statusCode).toBe(404);
    expect((await server.app.inject({ url: '/i18n' })).json()).toEqual({ langs: expect.arrayContaining(['ko', 'en', 'id', 'th']) });
  });
});

describe('content', () => {
  it('stock info includes limits, market cap and a localized profile', async () => {
    const server = await start();
    const res = await server.app.inject({ url: '/symbols/000001/info?lang=id' });
    const info = res.json() as Record<string, unknown> & { lastPrice: number; sharesListed: number; marketCap: number };
    expect(info).toMatchObject({ code: '000001', sector: 'electronics', tickSize: 100, limits: { lower: 49_900, upper: 92_500 } });
    expect(info.marketCap).toBe(info.lastPrice * info.sharesListed);
    expect(info.profile).toMatch(/^Perusahaan/);
    expect(info.day).toMatchObject({ open: expect.any(Number), volume: expect.any(Number) });
    expect((await server.app.inject({ url: '/symbols/999999/info' })).statusCode).toBe(404);
  });

  it('lists notices pinned first, filters by category and falls back to ko', async () => {
    const server = await start();
    const list = (await server.app.inject({ url: '/notices?lang=en' })).json() as { id: string; pinned: boolean; title: string }[];
    expect(list[0]!.pinned).toBe(true);
    expect(list.every((n) => /^[\x20-\x7E]+$/.test(n.title))).toBe(true);
    const events = (await server.app.inject({ url: '/notices?category=event' })).json() as { category: string }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((n) => n.category === 'event')).toBe(true);
    const unknownLang = (await server.app.inject({ url: '/notices/n-104?lang=xx' })).json() as { title: string; body: string };
    expect(unknownLang.title).toContain('점검');
    expect((await server.app.inject({ url: '/notices/nope' })).statusCode).toBe(404);
  });
});

describe('reconnect window', () => {
  it('widens with the number of clients being dropped and is clamped', async () => {
    const { reconnectWindowMs } = await import('../src/gateway/gateway.js');
    expect(reconnectWindowMs(1, 1000)).toBe(500);
    expect(reconnectWindowMs(5000, 1000)).toBe(5000);
    expect(reconnectWindowMs(10_000, 500)).toBe(20_000);
    expect(reconnectWindowMs(1_000_000, 1000)).toBe(30_000);
  });
});

describe('admin API', () => {
  it('requires the admin token', async () => {
    const server = await start();
    expect((await server.app.inject({ url: '/admin/api/state' })).statusCode).toBe(401);
    expect((await admin(server, 'GET', '/admin/api/state', undefined, 'wrong-token-xxxxx')).statusCode).toBe(401);
    expect((await admin(server, 'GET', '/admin/api/state')).statusCode).toBe(200);
  });

  it('changes faults at runtime and validates input', async () => {
    const server = await start();
    const applied = await admin(server, 'PUT', '/admin/api/faults', { dropSeqRate: 0.05, orderDelayMs: 1500, simIntervalMs: 0 });
    expect(applied.json()).toEqual({ dropSeqRate: 0.05, orderDelayMs: 1500, simIntervalMs: 0, simBurst: 1 });
    const state = (await admin(server, 'GET', '/admin/api/state')).json() as { faults: unknown };
    expect(state.faults).toEqual({ dropSeqRate: 0.05, orderDelayMs: 1500, simIntervalMs: 0, simBurst: 1 });

    expect((await admin(server, 'PUT', '/admin/api/faults', { dropSeqRate: 2 })).statusCode).toBe(400);
    expect((await admin(server, 'PUT', '/admin/api/faults', { shell: 'rm -rf' })).statusCode).toBe(400);
    expect((await admin(server, 'PUT', '/admin/api/faults', { simBurst: 51 })).statusCode).toBe(400);
  });

  it('raises the tick rate with simBurst (load experiment)', async () => {
    const server = await start();
    const deltas = () => server.metrics.sum('hoga_market_deltas_total');
    const measure = async () => {
      const before = deltas();
      await new Promise((r) => setTimeout(r, 300));
      return deltas() - before;
    };
    await admin(server, 'PUT', '/admin/api/faults', { simIntervalMs: 10, simBurst: 1 });
    const slow = await measure();
    // 주기를 생략하면 지금 주기(10ms)를 유지하고 횟수만 바꾼다
    const applied = await admin(server, 'PUT', '/admin/api/faults', { simBurst: 10 });
    expect(applied.json()).toMatchObject({ simIntervalMs: 10, simBurst: 10 });
    const fast = await measure();
    expect(fast).toBeGreaterThan(slow * 4);
    await admin(server, 'PUT', '/admin/api/faults', { simIntervalMs: 0 });
  });

  it('applies the order delay to order responses', async () => {
    const server = await start();
    await admin(server, 'PUT', '/admin/api/faults', { orderDelayMs: 300 });
    const login = (
      await server.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'demo', password: 'hoga-demo-1234' } })
    ).json() as { accessToken: string };
    const started = Date.now();
    const res = await server.app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${login.accessToken}`, 'idempotency-key': 'admin-delay-test-0001' },
      payload: { symbol: '000001', side: 'bid', type: 'limit', price: 60_000, qty: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });

  it('sets volatility per symbol or for all', async () => {
    const server = await start();
    await admin(server, 'PUT', '/admin/api/volatility', { multiplier: 5, symbol: '000002' });
    expect(server.market.volatility('000002')).toBe(5);
    expect(server.market.volatility('000001')).toBe(1);
    await admin(server, 'PUT', '/admin/api/volatility', { multiplier: 2 });
    expect(server.market.volatility('000001')).toBe(2);
    expect((await admin(server, 'PUT', '/admin/api/volatility', { multiplier: 5, symbol: '999999' })).statusCode).toBe(404);
  });

  it('disconnects every WebSocket client', async () => {
    const { default: WebSocket } = await import('ws');
    const server = await start();
    const ws = new WebSocket(`${server.url().replace('http', 'ws')}/ws`);
    await new Promise((resolve) => ws.once('open', resolve));
    const closed = new Promise<[number, string]>((resolve) => ws.once('close', (code, reason) => resolve([code, reason.toString()])));
    expect((await admin(server, 'POST', '/admin/api/disconnect', {})).json()).toEqual({ closed: 1 });
    // 1012 + 재접속 창(연결 1개면 최소값 0.5초)
    expect(await closed).toEqual([1012, 'admin disconnect; retry-window=500']);
  });
});
