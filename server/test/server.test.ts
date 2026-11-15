import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createServer, type HogaServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ServerMessage } from '../src/protocol.js';

const servers: HogaServer[] = [];

async function start(env: Record<string, string> = {}) {
  const server = createServer(
    loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', SIM_INTERVAL_MS: '0', ...env }),
  );
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

async function postOrder(server: HogaServer, body: unknown, key = randomUUID()) {
  const res = await fetch(`${server.url()}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown>, key };
}

describe('HTTP API', () => {
  it('헬스 체크와 종목 목록', async () => {
    const server = await start();
    const health = await (await fetch(`${server.url()}/healthz`)).json();
    expect(health).toMatchObject({ ok: true, coreVersion: '0.2.0-m2' });
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
    const noKey = await fetch(`${server.url()}/orders`, {
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
    const lookup = await fetch(`${server.url()}/orders/${key}`);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ key, status: 'NEW', resting: 5 });

    expect((await pending).body.orderId).toBeGreaterThan(0);
  });

  it('대기 주문 취소', async () => {
    const server = await start();
    const order = await postOrder(server, { symbol: '000003', side: 'bid', price: 4_210, qty: 3 });
    const res = await fetch(`${server.url()}/orders/${order.key}/cancel`, { method: 'POST' });
    expect(await res.json()).toMatchObject({ status: 'CANCELLED' });
    const again = await fetch(`${server.url()}/orders/${order.key}/cancel`, { method: 'POST' });
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
    for (let i = 0; i < 40; i++) {
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
  });

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
