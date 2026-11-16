/**
 * 여러 프로세스 구성(ROLE=market 1 + gateway 2, Redis)을 한 프로세스 안에서 띄워 확인한다.
 * redis-server가 없으면 건너뛴다(CI 맥에는 Homebrew redis가 있다).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Redis } from 'ioredis';

import { createGatewayServer, createServer, type GatewayServer, type HogaServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ServerMessage } from '../src/protocol.js';
import { RedisRefreshStore } from '../src/redis/refreshStore.js';

const hasRedis = spawnSync('redis-server', ['--version']).status === 0;
const PORT = 6300 + Math.floor(Math.random() * 600);
const REDIS_URL = `redis://127.0.0.1:${PORT}`;
let redisProcess: ChildProcess | undefined;

const running: Array<{ stop(): Promise<void> }> = [];

beforeAll(async () => {
  if (!hasRedis) return;
  redisProcess = spawn('redis-server', ['--port', String(PORT), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  const probe = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => 100 });
  for (let i = 0; i < 50; i++) {
    if (await probe.connect().then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await probe.flushall();
  probe.disconnect();
});

afterAll(() => {
  redisProcess?.kill();
});

afterEach(async () => {
  while (running.length) await running.pop()!.stop();
  const r = new Redis(REDIS_URL);
  await r.flushall();
  r.disconnect();
});

const base = { HOST: '127.0.0.1', LOG_LEVEL: 'silent', REDIS_URL, SIM_INTERVAL_MS: '0' } as const;

async function market(env: Record<string, string> = {}): Promise<HogaServer> {
  const server = createServer(loadConfig({ ...base, PORT: '0', ROLE: 'market', ...env }));
  await server.start();
  running.push(server);
  return server;
}

async function gatewayFor(m: HogaServer, id: string): Promise<GatewayServer> {
  const gw = createGatewayServer(loadConfig({ ...base, PORT: '0', ROLE: 'gateway', MARKET_URL: m.url(), GATEWAY_ID: id }));
  await gw.start();
  running.unshift(gw); // market보다 먼저 멈춘다
  return gw;
}

async function client(url: string) {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`);
  const messages: ServerMessage[] = [];
  let close: [number, string] | undefined;
  ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
  ws.on('close', (code, reason) => (close = [code, reason.toString()]));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const until = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ws, messages, until, send: (m: unknown) => ws.send(JSON.stringify(m)), closed: () => close };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as Record<string, unknown> };
}

const login = (m: HogaServer) => post(`${m.url()}/auth/login`, { username: 'demo', password: 'hoga-demo-1234' });

describe.skipIf(!hasRedis)('cluster: market + gateways over Redis', () => {
  it('fans the same deltas out from both gateways, starting from a replica snapshot that matches the market', async () => {
    const m = await market();
    m.market.warmUp(30);
    const [a, b] = [await gatewayFor(m, 'gw-a'), await gatewayFor(m, 'gw-b')];
    const ca = await client(a.url());
    const cb = await client(b.url());
    ca.send({ op: 'sub', symbols: ['000001'] });
    cb.send({ op: 'sub', symbols: ['000001'] });
    await ca.until(() => ca.messages.some((x) => x.t === 'snap'));
    await cb.until(() => cb.messages.some((x) => x.t === 'snap'));
    const snapA = ca.messages.find((x) => x.t === 'snap') as Extract<ServerMessage, { t: 'snap' }>;
    const fromMarket = m.market.snapshot('000001');
    expect({ seq: snapA.seq, bids: snapA.bids, asks: snapA.asks }).toEqual({ seq: fromMarket.seq, bids: fromMarket.bids, asks: fromMarket.asks });

    m.market.warmUp(10);
    const deltas = (c: typeof ca) => c.messages.filter((x) => x.t === 'delta').map((x) => (x as { seq: number }).seq);
    await ca.until(() => deltas(ca).at(-1) === m.market.snapshot('000001').seq);
    await cb.until(() => deltas(cb).at(-1) === m.market.snapshot('000001').seq);
    expect(deltas(ca)).toEqual(deltas(cb));
    // 빈틈없이 이어진다
    expect(deltas(ca).every((s, i, arr) => i === 0 || s === arr[i - 1]! + 1)).toBe(true);
    expect(deltas(ca)[0]).toBe(snapA.seq + 1);
  });

  it('delivers my order events to whichever gateway I am connected to', async () => {
    const m = await market();
    m.market.warmUp(30);
    const gw = await gatewayFor(m, 'gw-a');
    const { body } = await login(m);
    const c = await client(gw.url());
    c.send({ op: 'auth', token: body.accessToken });
    await c.until(() => c.messages.some((x) => x.t === 'authed'));
    const res = await post(
      `${m.url()}/orders`,
      { symbol: '000001', side: 'bid', type: 'limit', price: 60_000, qty: 1 },
      { authorization: `Bearer ${body.accessToken}`, 'idempotency-key': 'cluster-order-0001' },
    );
    expect(res.status).toBe(200);
    await c.until(() => c.messages.some((x) => x.t === 'order' && x.key === 'cluster-order-0001'));
  });

  it('admin disconnect reaches every gateway; admin state sums gateway connections', async () => {
    const m = await market();
    const [a, b] = [await gatewayFor(m, 'gw-a'), await gatewayFor(m, 'gw-b')];
    const ca = await client(a.url());
    const cb = await client(b.url());
    const admin = { 'x-admin-token': 'hoga-admin-dev-token' };
    // gateway 통계는 1초마다 올라온다
    await new Promise((r) => setTimeout(r, 1_200));
    const state = (await (await fetch(`${m.url()}/admin/api/state`, { headers: admin })).json()) as {
      counters: { connections: number };
      gateways: { id: string; connections: number }[];
    };
    expect(state.counters.connections).toBe(2);
    expect(state.gateways.map((g) => g.id)).toEqual(['gw-a', 'gw-b']);

    expect((await post(`${m.url()}/admin/api/disconnect`, {}, admin)).body).toEqual({ closed: null });
    await ca.until(() => ca.closed() !== undefined);
    await cb.until(() => cb.closed() !== undefined);
    expect(ca.closed()).toEqual([1012, 'admin disconnect; retry-window=500']);
    expect(cb.closed()?.[0]).toBe(1012);
  });

  it('keeps idempotency keys and refresh tokens across a market restart', async () => {
    const first = await market();
    const { body } = await login(first);
    const order = { symbol: '000001', side: 'bid', type: 'limit', price: 60_000, qty: 2 };
    const headers = { authorization: `Bearer ${body.accessToken as string}`, 'idempotency-key': 'restart-key-0001' };
    const created = await post(`${first.url()}/orders`, order, headers);
    await running.pop()!.stop(); // market 재시작

    const second = await market();
    const replayed = await post(`${second.url()}/orders`, order, headers);
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get('idempotent-replayed')).toBe('true');
    expect(replayed.body.orderId).toBe(created.body.orderId);
    // 재시작 전에 받은 리프레시 토큰으로 계속 로그인 유지
    const rotated = await post(`${second.url()}/auth/refresh`, { refreshToken: body.refreshToken });
    expect(rotated.status).toBe(200);
    // 이미 쓴 토큰을 다시 쓰면 탈취로 보고 계열 전체 폐기
    expect((await post(`${second.url()}/auth/refresh`, { refreshToken: body.refreshToken })).body).toEqual({ error: 'REFRESH_REUSED' });
    expect((await post(`${second.url()}/auth/refresh`, { refreshToken: rotated.body.refreshToken })).status).toBe(401);
  });

  it('lets only one of two simultaneous refreshes win (atomic consume)', async () => {
    const redis = new Redis(REDIS_URL);
    const store = new RedisRefreshStore(redis);
    await store.save('h1', { userId: 'u', familyId: 'f', expiresAt: Date.now() + 60_000 });
    const results = await Promise.all([store.consume('h1'), store.consume('h1'), store.consume('h1')]);
    expect(results.map((r) => r.state).sort()).toEqual(['ok', 'reused', 'reused']);
    expect(await store.consume('nope')).toEqual({ state: 'missing' });
    redis.disconnect();
  });

  it('rejects ROLE=market/gateway without Redis', () => {
    expect(() => loadConfig({ ROLE: 'gateway' })).toThrow(/REDIS_URL/);
  });
});
