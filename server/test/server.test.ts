import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createServer, type HogaServer } from '../src/app.js';
import { TEST_OPTIONS } from './fixtures.js';
import { loadConfig } from '../src/config.js';
import type { ServerMessage } from '../src/protocol.js';

const servers: HogaServer[] = [];

async function start(env: Record<string, string> = {}) {
  const server = createServer(
    loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', SIM_INTERVAL_MS: '0', ...env }), TEST_OPTIONS);
  await server.start();
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

/** 받은 메시지를 모아 두고 조건이 맞을 때까지 기다리는 테스트용 클라이언트 */
async function connect(server: HogaServer) {
  const ws = new WebSocket(`${server.url().replace('http', 'ws')}/ws`);
  const messages: ServerMessage[] = [];
  let closeCode: number | undefined;
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  ws.on('close', (code) => {
    closeCode = code;
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const waitFor = async <T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = messages.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timeout waiting for message');
  };
  return {
    ws,
    messages,
    waitFor,
    send: (msg: unknown) => ws.send(JSON.stringify(msg)),
    closeCode: () => closeCode,
  };
}

const isType =
  <K extends ServerMessage['t']>(t: K) =>
  (m: ServerMessage): m is Extract<ServerMessage, { t: K }> =>
    m.t === t;

const tokens = new Map<string, string>();

/** 테스트용 모의 사용자 로그인(서버 시드 값) */
async function login(server: HogaServer, username = 'demo', password = 'hoga-demo-1234') {
  const res = await fetch(`${server.url()}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as { accessToken: string; refreshToken: string; user: { id: string } };
  return { status: res.status, ...body };
}

async function tokenFor(server: HogaServer, username = 'demo') {
  const cacheKey = `${server.url()}|${username}`;
  if (!tokens.has(cacheKey)) {
    const password = username === 'demo' ? 'hoga-demo-1234' : 'hoga-trader-5678';
    tokens.set(cacheKey, (await login(server, username, password)).accessToken);
  }
  return tokens.get(cacheKey)!;
}

async function postOrder(server: HogaServer, body: unknown, key = randomUUID(), username = 'demo') {
  const res = await fetch(`${server.url()}/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      authorization: `Bearer ${await tokenFor(server, username)}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown>, key };
}

async function authed(server: HogaServer, path: string, init: RequestInit = {}, username = 'demo') {
  return fetch(`${server.url()}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${await tokenFor(server, username)}` },
  });
}

describe('HTTP API', () => {
  it('헬스 체크와 종목 목록', async () => {
    const server = await start();
    const health = await (await fetch(`${server.url()}/healthz`)).json();
    expect(health).toMatchObject({ ok: true, coreVersion: '0.4.0-m4' });
    const symbols = (await (await fetch(`${server.url()}/symbols`)).json()) as { code: string }[];
    expect(symbols.map((s) => s.code)).toContain('000001');
    expect((await fetch(`${server.url()}/book/999999`)).status).toBe(404);
  });

  it('같은 Idempotency-Key로 다시 보내면 다시 처리하지 않고 처음 결과를 돌려준다', async () => {
    const server = await start();
    const body = { symbol: '000001', side: 'bid', price: 71_200, qty: 10 };
    const first = await postOrder(server, body);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('NEW');

    const replay = await postOrder(server, body, first.key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.orderId).toBe(first.body.orderId);

    // 호가창에는 한 번만 들어가 있다
    const book = (await (await fetch(`${server.url()}/book/000001`)).json()) as { bids: number[][] };
    expect(book.bids).toEqual([[71_200, 10]]);

    const conflict = await postOrder(server, { ...body, qty: 11 }, first.key);
    expect(conflict.status).toBe(422);
  });

  it('형식 오류는 400, 업무 규칙 위반은 200 + REJECTED', async () => {
    const server = await start();
    const noKey = await authed(server, '/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: '000001', side: 'bid', price: 71_200, qty: 1 }),
    });
    expect(noKey.status).toBe(400);
    expect((await postOrder(server, { symbol: '000001', side: 'bid', price: 71_200, qty: 1.5 })).status).toBe(400);

    const offTick = await postOrder(server, { symbol: '000001', side: 'bid', price: 71_250, qty: 1 });
    expect(offTick.status).toBe(200);
    expect(offTick.body).toMatchObject({ status: 'REJECTED', reject: 'OFF_TICK', orderId: 0 });
  });

  it('응답이 늦어도 주문은 이미 접수돼 있어 GET /orders/:key로 확정할 수 있다', async () => {
    const server = await start({ FAULT_ORDER_DELAY_MS: '1000' });
    const key = randomUUID();
    const pending = postOrder(server, { symbol: '000002', side: 'ask', price: 18_500, qty: 5 }, key);

    await new Promise((r) => setTimeout(r, 150));
    const lookup = await authed(server, `/orders/${key}`);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ key, status: 'NEW', resting: 5 });

    expect((await pending).body.orderId).toBeGreaterThan(0);
  });

  it('대기 주문 취소', async () => {
    const server = await start();
    const order = await postOrder(server, { symbol: '000003', side: 'bid', price: 4_210, qty: 3 });
    const res = await authed(server, `/orders/${order.key}/cancel`, { method: 'POST' });
    expect(await res.json()).toMatchObject({ status: 'CANCELLED' });
    const again = await authed(server, `/orders/${order.key}/cancel`, { method: 'POST' });
    expect(await again.json()).toMatchObject({ status: 'REJECTED', reject: 'UNKNOWN_ORDER' });
  });
});

describe('WebSocket gateway', () => {
  it('구독하면 스냅샷이 오고, 주문으로 바뀐 가격대가 seq+1 변경분으로 온다', async () => {
    const server = await start();
    const client = await connect(server);
    client.send({ op: 'sub', symbols: ['000001'] });
    const snap = await client.waitFor(isType('snap'));
    expect(snap.sym).toBe('000001');

    await postOrder(server, { symbol: '000001', side: 'bid', price: 71_100, qty: 7 });
    const delta = await client.waitFor(isType('delta'));
    expect(delta).toMatchObject({ sym: '000001', seq: snap.seq + 1, side: 'B', px: 71_100, qty: 7 });

    await postOrder(server, { symbol: '000001', side: 'ask', price: 71_100, qty: 2 });
    const trade = await client.waitFor(isType('trade'));
    expect(trade).toMatchObject({ px: 71_100, qty: 2, aggr: 'A' });
    client.ws.close();
  });

  it('잘못된 메시지·없는 종목·구독 초과는 오류 메시지로 거부한다', async () => {
    const server = await start({ WS_MAX_SUBSCRIPTIONS: '2' });
    const client = await connect(server);
    client.ws.send('not json');
    client.send({ op: 'sub', symbols: ['999999'] });
    client.send({ op: 'sub', symbols: ['000001', '000002', '000003'] });
    await new Promise((r) => setTimeout(r, 200));
    const codes = client.messages.filter(isType('error')).map((m) => m.code);
    expect(codes).toEqual(['BAD_MESSAGE', 'UNKNOWN_SYMBOL', 'TOO_MANY_SUBSCRIPTIONS']);
    client.ws.close();
  });

  it('초당 메시지 수를 넘으면 RATE_LIMITED', async () => {
    const server = await start({ WS_MSG_RATE_PER_SEC: '3' });
    const client = await connect(server);
    for (let i = 0; i < 10; i++) client.send({ op: 'ping' });
    await new Promise((r) => setTimeout(r, 200));
    expect(client.messages.filter(isType('pong')).length).toBeLessThanOrEqual(4);
    expect(client.messages.some((m) => m.t === 'error' && m.code === 'RATE_LIMITED')).toBe(true);
    client.ws.close();
  });

  it('느린 클라이언트: 밀린 변경분은 건너뛰고 버퍼가 비면 최신 스냅샷으로 따라잡게 한다', async () => {
    const server = await start({ WS_SOFT_BUFFER_BYTES: '65536', WS_HARD_BUFFER_BYTES: '268435456' });
    const client = await connect(server);
    client.send({ op: 'sub', symbols: ['000001'] });
    const first = await client.waitFor(isType('snap'));

    // 클라이언트가 읽기를 멈춘 상태에서 시세를 대량으로 만든다 → 서버 송신 버퍼가 쌓인다
    const socket = (client.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    socket.pause();
    // 건너뛰기(conflation)가 시작될 때까지만 만든다(고정 횟수로 돌리면 CI에서 빌드와 겹칠 때 5초를 넘긴다)
    for (let i = 0; i < 40 && server.metrics.get('hoga_ws_conflated_total') === 0; i++) {
      server.market.warmUp(1000);
      await new Promise((r) => setImmediate(r));
    }
    expect(server.metrics.get('hoga_ws_conflated_total')).toBeGreaterThan(0);
    socket.resume();

    // 버퍼가 비면 다음 변경분 대신 새 스냅샷이 온다
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && client.messages.filter(isType('snap')).length < 2) {
      server.market.warmUp(1);
      await new Promise((r) => setTimeout(r, 20));
    }
    const snaps = client.messages.filter(isType('snap'));
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    expect(snaps[1]!.seq).toBeGreaterThan(first.seq);

    // 새 스냅샷 이후의 변경분은 다시 seq가 이어진다
    const afterIdx = client.messages.indexOf(snaps[1]!);
    let seq = snaps[1]!.seq;
    for (const m of client.messages.slice(afterIdx).filter(isType('delta')).filter((d) => d.sym === '000001')) {
      expect(m.seq).toBe(seq + 1);
      seq = m.seq;
    }
    client.ws.close();
  }, 20_000);

  it('서버 종료 시 1012(서비스 재시작)로 닫는다', async () => {
    const server = await start();
    const client = await connect(server);
    await servers.pop()!.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(client.closeCode()).toBe(1012);
  });

  it('시뮬레이터가 켜져 있어도 클라이언트 재구성이 서버 호가와 일치한다', async () => {
    const server = await start({ SIM_INTERVAL_MS: '5' });
    const client = await connect(server);
    client.send({ op: 'sub', symbols: ['000005'] });
    const snap = await client.waitFor(isType('snap'));
    await new Promise((r) => setTimeout(r, 500));

    const bids = new Map(snap.bids);
    const asks = new Map(snap.asks);
    let seq = snap.seq;
    for (const m of client.messages.filter(isType('delta'))) {
      expect(m.seq).toBe(seq + 1);
      const book = m.side === 'B' ? bids : asks;
      if (m.qty === 0) book.delete(m.px);
      else book.set(m.px, m.qty);
      seq = m.seq;
    }
    expect(seq).toBeGreaterThan(snap.seq);

    const latest = server.market.snapshot('000005', 1000);
    if (latest.seq === seq) {
      const top = (m: Map<number, number>, desc: boolean) =>
        [...m.entries()].sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).slice(0, 5);
      expect(top(bids, true)).toEqual(latest.bids.slice(0, 5));
      expect(top(asks, false)).toEqual(latest.asks.slice(0, 5));
    }
    client.ws.close();
  });
});

describe('인증', () => {
  it('로그인 성공·실패, 실패가 반복되면 429', async () => {
    const server = await start({ LOGIN_MAX_FAILURES_PER_MIN: '3' });
    const ok = await login(server);
    expect(ok.status).toBe(200);
    expect(ok.user.id).toBe('u-demo');
    for (let i = 0; i < 3; i++) expect((await login(server, 'demo', 'wrong')).status).toBe(401);
    expect((await login(server, 'demo', 'wrong')).status).toBe(429);
  });

  it('주문 API는 토큰 없이는 401, 만료 토큰은 TOKEN_EXPIRED', async () => {
    const server = await start({ ACCESS_TOKEN_TTL_SEC: '10' });
    const res = await fetch(`${server.url()}/orders`);
    expect(res.status).toBe(401);
    const bad = await fetch(`${server.url()}/orders`, { headers: { authorization: 'Bearer abc.def.ghi' } });
    expect(bad.status).toBe(401);
  });

  it('리프레시 토큰은 회전되고, 이미 쓴 토큰을 다시 쓰면 그 계열 전체가 무효가 된다', async () => {
    const server = await start();
    const first = await login(server);
    const refresh = (token: string) =>
      fetch(`${server.url()}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
    const second = (await (await refresh(first.refreshToken)).json()) as { refreshToken: string };
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // 탈취된 이전 토큰 재사용 → 거부 + 정상 사용자의 최신 토큰도 무효화
    const reuse = await refresh(first.refreshToken);
    expect(reuse.status).toBe(401);
    expect(await reuse.json()).toEqual({ error: 'REFRESH_REUSED' });
    expect((await refresh(second.refreshToken)).status).toBe(401);
  });
});

describe('사용자별 주문', () => {
  it('멱등 키·조회·취소는 사용자별로 분리된다', async () => {
    const server = await start();
    const key = randomUUID();
    const mine = await postOrder(server, { symbol: '000001', side: 'bid', price: 71_000, qty: 1 }, key, 'demo');
    // 같은 키를 다른 사용자가 써도 충돌하지 않는다
    const theirs = await postOrder(server, { symbol: '000001', side: 'bid', price: 70_900, qty: 2 }, key, 'trader2');
    expect(theirs.status).toBe(200);
    expect(theirs.body.orderId).not.toBe(mine.body.orderId);

    expect((await authed(server, `/orders/${key}`, {}, 'trader2')).status).toBe(200);
    const list = (await (await authed(server, '/orders', {}, 'demo')).json()) as { key: string; price: number }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.price).toBe(71_000);
  });

  it('내 대기 주문이 다른 사람 주문으로 체결되면 나에게만 order 이벤트가 온다', async () => {
    const server = await start();
    const me = await connect(server);
    const other = await connect(server);
    me.send({ op: 'auth', token: await tokenFor(server, 'demo') });
    other.send({ op: 'auth', token: await tokenFor(server, 'trader2') });
    await me.waitFor(isType('authed'));
    await other.waitFor(isType('authed'));

    const order = await postOrder(server, { symbol: '000002', side: 'bid', price: 18_400, qty: 10 }, randomUUID(), 'demo');
    expect(order.body.status).toBe('NEW');
    await postOrder(server, { symbol: '000002', side: 'ask', price: 18_400, qty: 4 }, randomUUID(), 'trader2');

    const fillEvent = await me.waitFor(
      (m): m is Extract<ServerMessage, { t: 'order' }> => m.t === 'order' && m.key === order.key && m.filled === 4,
    );
    expect(fillEvent).toMatchObject({ status: 'PARTIALLY_FILLED', resting: 6, fill: { price: 18_400, qty: 4 } });
    // 상대에게는 내 주문 알림이 가지 않는다
    expect(other.messages.some((m) => m.t === 'order' && m.key === order.key)).toBe(false);

    const latest = (await (await authed(server, `/orders/${order.key}`)).json()) as { filled: number; status: string };
    expect(latest).toMatchObject({ filled: 4, status: 'PARTIALLY_FILLED' });
    me.ws.close();
    other.ws.close();
  });

  it('잘못된 토큰으로 WS 인증하면 UNAUTHORIZED', async () => {
    const server = await start();
    const client = await connect(server);
    client.send({ op: 'auth', token: 'not-a-real-token' });
    const err = await client.waitFor(isType('error'));
    expect(err.code).toBe('UNAUTHORIZED');
    client.ws.close();
  });
});

describe('봉(차트)', () => {
  it('시작 시 과거 봉을 채우고, 체결이 나면 마지막 봉이 갱신된다', async () => {
    const server = await start({ HISTORY_MINUTES: '30' });
    const get = async (q = '') =>
      (await (await fetch(`${server.url()}/candles/000001${q}`)).json()) as { interval: number; bars: number[][] };
    const first = await get();
    expect(first.interval).toBe(60_000);
    expect(first.bars.length).toBe(30);
    for (const [start, open, high, low, close, volume] of first.bars) {
      expect(start! % 60_000).toBe(0);
      expect(high).toBeGreaterThanOrEqual(Math.max(open!, close!));
      expect(low).toBeLessThanOrEqual(Math.min(open!, close!));
      expect(volume).toBeGreaterThan(0);
    }
    const five = await get('?interval=5m');
    expect(five.interval).toBe(300_000);
    expect(five.bars.length).toBeLessThanOrEqual(7);

    await postOrder(server, { symbol: '000001', side: 'ask', price: 71_200, qty: 3 });
    await postOrder(server, { symbol: '000001', side: 'bid', price: 71_200, qty: 3 }, randomUUID(), 'trader2');
    const after = await get();
    const last = after.bars.at(-1)!;
    expect(last[4]).toBe(71_200); // 종가 = 방금 체결가
    expect((await fetch(`${server.url()}/candles/000001?interval=2m`)).status).toBe(400);
  });
});
