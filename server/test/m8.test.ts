/**
 * M8: 계좌(잔고·주문가능·정정), 장 운영 구간·단일가·VI, 강제 업데이트·점검, 비대면 계좌 개설.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createServer, type HogaServer } from '../src/app.js';
import { TEST_OPTIONS } from './fixtures.js';
import { maskBirth, maskName, maskPhone } from '../src/api/accountOpen.js';
import { compareVersions } from '../src/api/appConfig.js';
import { loadConfig } from '../src/config.js';
import { krxPhase } from '../src/market/session.js';
import type { ServerMessage, StatusMessage } from '../src/protocol.js';

const servers: HogaServer[] = [];
const ADMIN = { 'x-admin-token': 'hoga-admin-dev-token' };
const PASSWORDS: Record<string, string> = { demo: 'hoga-demo-1234', trader2: 'hoga-trader-5678' };

async function start(env: Record<string, string> = {}) {
  const server = createServer(
    loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', SIM_INTERVAL_MS: '0', HISTORY_MINUTES: '0', ...env }), TEST_OPTIONS);
  await server.start();
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

type Json = Record<string, unknown>;

async function call(server: HogaServer, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${server.url()}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
}

const tokens = new Map<string, string>();
async function token(server: HogaServer, username: string, password = PASSWORDS[username]!) {
  const key = `${server.url()}|${username}`;
  if (!tokens.has(key)) {
    const res = await call(server, 'POST', '/auth/login', { username, password });
    tokens.set(key, res.body.accessToken as string);
  }
  return tokens.get(key)!;
}

async function as(server: HogaServer, user: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return call(server, method, path, body, { authorization: `Bearer ${await token(server, user)}`, ...headers });
}

const order = (server: HogaServer, user: string, body: Json, key = randomUUID()) =>
  as(server, user, 'POST', '/orders', { type: 'limit', ...body }, { 'idempotency-key': key });

const account = async (server: HogaServer, user = 'demo') =>
  (await as(server, user, 'GET', '/account')).body as {
    cash: number;
    reservedCash: number;
    availableCash: number;
    positions: { symbol: string; qty: number; sellable: number; avgPrice: number }[];
  };

async function ws(server: HogaServer) {
  const socket = new WebSocket(`${server.url().replace('http', 'ws')}/ws`);
  const messages: ServerMessage[] = [];
  socket.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  /** from: 이 위치 이후에 온 메시지만(이전 상태 메시지에 잘못 걸리지 않게) */
  const waitFor = async <T extends ServerMessage>(pred: (m: ServerMessage) => m is T, ms = 3000, from = 0): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const found = messages.slice(from).findLast(pred);
      if (found) return found;
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { socket, messages, waitFor, send: (m: unknown) => socket.send(JSON.stringify(m)) };
}

const statusWith =
  (pred: (s: StatusMessage) => boolean) =>
  (m: ServerMessage): m is StatusMessage =>
    m.t === 'status' && pred(m);

describe('계좌: 잔고·주문가능·체결 반영', () => {
  it('매수 대기 주문은 주문가능금액을 묶고, 취소하면 풀린다', async () => {
    const server = await start();
    const before = await account(server);
    expect(before.cash).toBe(50_000_000);
    expect(before.positions.find((p) => p.symbol === '000001')).toMatchObject({ qty: 100, sellable: 100 });

    const placed = await order(server, 'demo', { symbol: '000001', side: 'bid', price: 70_000, qty: 10 });
    expect(placed.body.status).toBe('NEW');
    const after = await account(server);
    expect(after.reservedCash).toBe(700_000);
    expect(after.availableCash).toBe(50_000_000 - 700_000);

    const orderable = await as(server, 'demo', 'GET', '/account/orderable?symbol=000001&side=bid&type=limit&price=70000');
    expect(orderable.body.maxQty).toBe(Math.floor((50_000_000 - 700_000) / 70_000));

    await as(server, 'demo', 'POST', `/orders/${placed.body.key as string}/cancel`);
    expect((await account(server)).availableCash).toBe(50_000_000);
  });

  it('주문가능금액·매도가능수량을 넘으면 C++ 규칙으로 거부', async () => {
    const server = await start();
    const tooBig = await order(server, 'demo', { symbol: '000004', side: 'bid', price: 152_300, qty: 400 });
    expect(tooBig.body).toMatchObject({ status: 'REJECTED', reject: 'INSUFFICIENT_CASH', orderId: 0 });
    // 시장가 매수는 상한가로 묶는다
    const marketBuy = await as(server, 'demo', 'GET', '/account/orderable?symbol=000004&side=bid&type=market');
    expect(marketBuy.body.unitPrice).toBe(server.market.upperLimit('000004'));

    const sell = await order(server, 'demo', { symbol: '000001', side: 'ask', price: 80_000, qty: 60 });
    expect(sell.body.status).toBe('NEW');
    const oversell = await order(server, 'demo', { symbol: '000001', side: 'ask', price: 80_000, qty: 41 });
    expect(oversell.body.reject).toBe('INSUFFICIENT_QTY');
    expect((await account(server)).positions.find((p) => p.symbol === '000001')?.sellable).toBe(40);
  });

  it('체결되면 예수금·보유 수량·평균단가가 바뀐다', async () => {
    const server = await start();
    const mine = await order(server, 'demo', { symbol: '000002', side: 'bid', price: 18_400, qty: 10 });
    await order(server, 'trader2', { symbol: '000002', side: 'ask', price: 18_400, qty: 4 });
    const a = await account(server);
    expect(a.cash).toBe(50_000_000 - 4 * 18_400);
    expect(a.reservedCash).toBe(6 * 18_400);
    const pos = a.positions.find((p) => p.symbol === '000002')!;
    expect(pos.qty).toBe(304);
    expect(pos.avgPrice).toBe(Math.round((300 * 19_100 + 4 * 18_400) / 304));
    expect(mine.body.status).toBe('NEW');
    const seller = (await account(server, 'trader2')).positions.find((p) => p.symbol === '000002')!;
    expect(seller.qty).toBe(496);
  });
});

describe('정정 주문', () => {
  it('원주문 잔량 일부를 새 가격으로 옮긴다(같은 화면 흐름: 새 멱등 키 + amendOf)', async () => {
    const server = await start();
    const original = await order(server, 'demo', { symbol: '000003', side: 'bid', price: 4_000, qty: 10 });
    const amended = await order(server, 'demo', {
      symbol: '000003',
      side: 'bid',
      price: 4_100,
      qty: 4,
      amendOf: original.body.key,
    });
    expect(amended.body).toMatchObject({ status: 'NEW', resting: 4, price: 4_100, amendOf: original.body.key });
    const before = (await as(server, 'demo', 'GET', `/orders/${original.body.key as string}`)).body;
    expect(before).toMatchObject({ resting: 6, amended: 4, status: 'NEW' });
    expect(server.market.snapshot('000003').bids).toEqual([
      [4_100, 4],
      [4_000, 6],
    ]);
    // 묶음: 6 × 4,000 + 4 × 4,100
    expect((await account(server)).reservedCash).toBe(6 * 4_000 + 4 * 4_100);
    const open = (await as(server, 'demo', 'GET', '/orders?status=open')).body as unknown as { key: string }[];
    expect(open.map((o) => o.key).sort()).toEqual([original.body.key, amended.body.key].sort());

    // 잔량보다 많이 정정하면 거부, 원주문은 그대로
    const tooMany = await order(server, 'demo', { symbol: '000003', side: 'bid', price: 4_050, qty: 7, amendOf: original.body.key });
    expect(tooMany.body.reject).toBe('EXCEEDS_OPEN_QTY');
    // 호가단위가 틀리면 원주문을 줄이기 전에 거부
    const offTick = await order(server, 'demo', { symbol: '000003', side: 'bid', price: 4_003, qty: 1, amendOf: original.body.key });
    expect(offTick.body.reject).toBe('OFF_TICK');
    expect((await as(server, 'demo', 'GET', `/orders/${original.body.key as string}`)).body.resting).toBe(6);

    // 전량 정정 → 원주문은 끝(취소 상태), 미체결에서 빠진다
    await order(server, 'demo', { symbol: '000003', side: 'bid', price: 4_050, qty: 6, amendOf: original.body.key });
    const done = (await as(server, 'demo', 'GET', `/orders/${original.body.key as string}`)).body;
    expect(done).toMatchObject({ resting: 0, amended: 10, status: 'CANCELLED' });
  });

  it('다른 사람 주문·다른 종목으로는 정정할 수 없다', async () => {
    const server = await start();
    const theirs = await order(server, 'trader2', { symbol: '000002', side: 'ask', price: 19_000, qty: 5 });
    const r = await order(server, 'demo', { symbol: '000002', side: 'ask', price: 19_100, qty: 1, amendOf: theirs.body.key });
    expect(r.body.reject).toBe('UNKNOWN_ORDER');
  });
});

describe('장 운영 구간 · 단일가 · VI', () => {
  it('동시호가에는 체결 없이 모으고 예상 체결가를 알리며, 장 시작에 한 가격으로 체결한다', async () => {
    const server = await start();
    const client = await ws(server);
    client.send({ op: 'sub', symbols: ['000002'] });
    await client.waitFor(statusWith((s) => s.phase === 'OPEN' && s.mode === 'CONTINUOUS'));

    expect((await call(server, 'PUT', '/admin/api/session', { phase: 'PRE_OPEN' }, ADMIN)).body).toEqual({ phase: 'PRE_OPEN' });
    await client.waitFor(statusWith((s) => s.phase === 'PRE_OPEN' && s.mode === 'AUCTION'));

    const bid = await order(server, 'demo', { symbol: '000002', side: 'bid', price: 18_500, qty: 10 });
    const ask = await order(server, 'trader2', { symbol: '000002', side: 'ask', price: 18_300, qty: 6 });
    expect(bid.body).toMatchObject({ status: 'NEW', filled: 0 });
    expect(ask.body).toMatchObject({ status: 'NEW', filled: 0 });
    const market = await as(server, 'demo', 'POST', '/orders', { symbol: '000002', side: 'bid', type: 'market', qty: 1 }, { 'idempotency-key': randomUUID() });
    expect(market.body.reject).toBe('MARKET_IN_AUCTION');
    const exp = await client.waitFor(statusWith((s) => s.exp !== null && s.exp.qty === 6));
    expect(exp.exp!.px).toBeGreaterThanOrEqual(18_300);
    expect(exp.exp!.px).toBeLessThanOrEqual(18_500);

    await call(server, 'PUT', '/admin/api/session', { phase: 'OPEN' }, ADMIN);
    await client.waitFor(statusWith((s) => s.phase === 'OPEN' && s.mode === 'CONTINUOUS' && s.exp === null));
    const mine = (await as(server, 'demo', 'GET', `/orders/${bid.body.key as string}`)).body;
    const theirs = (await as(server, 'trader2', 'GET', `/orders/${ask.body.key as string}`)).body;
    expect(mine).toMatchObject({ filled: 6, resting: 4, status: 'PARTIALLY_FILLED' });
    expect(theirs).toMatchObject({ filled: 6, status: 'FILLED' });
    // 단일가 체결분도 계좌에 반영(매수 쪽이 taker로 기록돼도)
    expect((await account(server)).positions.find((p) => p.symbol === '000002')!.qty).toBe(306);
    client.socket.close();
  });

  it('장 종료에는 새 주문을 받지 않고 취소는 된다', async () => {
    const server = await start();
    const placed = await order(server, 'demo', { symbol: '000001', side: 'bid', price: 70_000, qty: 1 });
    await call(server, 'PUT', '/admin/api/session', { phase: 'CLOSED' }, ADMIN);
    const closed = await order(server, 'demo', { symbol: '000001', side: 'bid', price: 70_000, qty: 1 });
    expect(closed.body.reject).toBe('MARKET_CLOSED');
    const cancel = await as(server, 'demo', 'POST', `/orders/${placed.body.key as string}/cancel`);
    expect(cancel.body.status).toBe('CANCELLED');
  });

  it('직전가에서 크게 움직이면 동적 VI → 그 종목만 단일가 → 시간이 지나면 해제', async () => {
    const server = await start({ VI_DYNAMIC_BPS: '50', VI_DURATION_MS: '1000' });
    const client = await ws(server);
    client.send({ op: 'sub', symbols: ['000001', '000002'] });
    await client.waitFor(statusWith((s) => s.sym === '000001'));
    // 기준가 71,200 → 72,000(+1.1%) 체결
    await order(server, 'demo', { symbol: '000001', side: 'ask', price: 72_000, qty: 1 });
    await order(server, 'trader2', { symbol: '000001', side: 'bid', price: 72_000, qty: 1 });
    const vi = await client.waitFor(statusWith((s) => s.sym === '000001' && s.vi !== null));
    expect(vi).toMatchObject({ mode: 'AUCTION', vi: { kind: 'DYNAMIC', ref: 71_200 } });
    expect(server.market.mode('000002')).toBe('CONTINUOUS');
    // VI 중에는 겹치는 주문도 체결되지 않는다
    await order(server, 'demo', { symbol: '000001', side: 'ask', price: 72_000, qty: 2 });
    const during = await order(server, 'trader2', { symbol: '000001', side: 'bid', price: 72_100, qty: 2 });
    expect(during.body.filled).toBe(0);
    const viAt = client.messages.indexOf(vi);
    await client.waitFor(statusWith((s) => s.sym === '000001' && s.vi === null && s.mode === 'CONTINUOUS'), 3000, viAt);
    expect((await as(server, 'trader2', 'GET', `/orders/${during.body.key as string}`)).body.filled).toBe(2);
    client.socket.close();
  });

  it('관리 콘솔에서 VI 발동·해제, 장중이 아니면 409', async () => {
    const server = await start();
    const r = await call(server, 'POST', '/admin/api/vi', { symbol: '000003', action: 'trigger' }, ADMIN);
    expect((r.body.vi as { symbol: string }[]).map((v) => v.symbol)).toEqual(['000003']);
    expect(server.session.status('000003').mode).toBe('AUCTION');
    await call(server, 'POST', '/admin/api/vi', { symbol: '000003', action: 'release' }, ADMIN);
    expect(server.session.status('000003').mode).toBe('CONTINUOUS');
    await call(server, 'PUT', '/admin/api/session', { phase: 'CLOSED' }, ADMIN);
    expect((await call(server, 'POST', '/admin/api/vi', { symbol: '000003', action: 'trigger' }, ADMIN)).status).toBe(409);
  });

  it('krx 시계: 서울 시각 평일 정규장, 주말은 장 종료', () => {
    // 2026-11-16(월) 09:30 KST = 00:30 UTC
    expect(krxPhase(Date.UTC(2026, 10, 16, 0, 30))).toBe('OPEN');
    expect(krxPhase(Date.UTC(2026, 10, 15, 23, 45))).toBe('PRE_OPEN');
    expect(krxPhase(Date.UTC(2026, 10, 16, 6, 25))).toBe('CLOSING');
    expect(krxPhase(Date.UTC(2026, 10, 16, 7, 0))).toBe('CLOSED');
    expect(krxPhase(Date.UTC(2026, 10, 15, 0, 30))).toBe('CLOSED'); // 일요일
  });
});

describe('강제 업데이트 · 점검', () => {
  const config = (server: HogaServer, version: string) => call(server, 'GET', `/app/config?platform=ios&version=${version}&lang=ko`);

  it('최소 버전보다 낮으면 required, 최신보다 낮으면 optional', async () => {
    const server = await start();
    expect((await config(server, '0.8.0')).body).toMatchObject({ update: 'none', maintenance: { active: false } });
    await call(server, 'PUT', '/admin/api/app-config', { minVersion: '0.8.0', latestVersion: '0.9.0' }, ADMIN);
    expect((await config(server, '0.7.9')).body.update).toBe('required');
    expect((await config(server, '0.8.0')).body.update).toBe('optional');
    expect((await call(server, 'GET', '/app/config?platform=web&version=1')).status).toBe(400);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
  });

  it('점검 중에는 주문·계좌·로그인 API가 503, 원격 설정·시세는 그대로', async () => {
    const server = await start();
    const demoToken = await token(server, 'demo');
    await call(server, 'PUT', '/admin/api/app-config', { maintenance: { active: true, until: 1_900_000_000_000 } }, ADMIN);
    const blocked = await call(server, 'POST', '/orders', {}, { authorization: `Bearer ${demoToken}` });
    expect(blocked).toEqual({ status: 503, body: { error: 'MAINTENANCE', until: 1_900_000_000_000 } });
    expect((await call(server, 'POST', '/auth/login', { username: 'demo', password: 'x' })).status).toBe(503);
    expect((await config(server, '0.8.0')).body.maintenance).toMatchObject({ active: true, until: 1_900_000_000_000 });
    expect((await call(server, 'GET', '/symbols')).status).toBe(200);
    await call(server, 'PUT', '/admin/api/app-config', { maintenance: { active: false } }, ADMIN);
    expect((await call(server, 'GET', '/account', undefined, { authorization: `Bearer ${demoToken}` })).status).toBe(200);
  });
});

describe('비대면 계좌 개설', () => {
  // 가장 작은 JPEG 모양(시작·끝 표시만 본다)
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]).toString('base64');

  it('약관 → 정보 → 휴대폰 → 신분증 → 완료 후 새 계정으로 로그인하고 모의 입금된 계좌를 본다', async () => {
    const server = await start();
    const created = await call(server, 'POST', '/account-open');
    const { id, token: appToken } = created.body as { id: string; token: string };
    const h = { 'x-application-token': appToken };
    const step = (path: string, body?: unknown) => call(server, 'POST', `/account-open/${id}${path}`, body ?? {}, h);

    // 순서를 건너뛸 수 없다
    expect((await step('/profile', {})).status).toBe(409);
    expect((await step('/terms', { required: true, privacy: false })).body.error).toBe('TERMS_REQUIRED');
    expect((await step('/terms', { required: true, privacy: true })).body.step).toBe('profile');

    expect((await step('/profile', { name: '김신규', birth: '20150101', phone: '01012345678', username: 'newbie01' })).body.error).toBe('UNDERAGE');
    expect((await step('/profile', { name: '김신규', birth: '19900101', phone: '01012345678', username: 'demo' })).body.error).toBe(
      'USERNAME_TAKEN',
    );
    const profile = await step('/profile', { name: '김신규', birth: '19900101', phone: '01012345678', username: 'newbie01' });
    expect(profile.body).toMatchObject({ step: 'phone', profile: { name: '김*규', birth: '1990-**-**', phone: '010-****-5678' } });

    const sent = await step('/phone/send');
    expect((await step('/phone/verify', { code: '000000' === sent.body.devCode ? '111111' : '000000' })).body.error).toBe('WRONG_CODE');
    expect((await step('/phone/verify', { code: sent.body.devCode })).body.step).toBe('idcard');

    expect((await step('/id-card', { image: Buffer.from('not a jpeg').toString('base64') })).body.error).toBe('NOT_JPEG');
    expect((await step('/id-card', { image: jpeg })).body).toMatchObject({ step: 'done', idCardVerified: true });

    expect((await step('/complete', { password: 'short', accountPin: '1234' })).body.error).toBe('INVALID_PASSWORD');
    const done = await step('/complete', { password: 'newbie-pass-1', accountPin: '1234' });
    expect(done.body).toMatchObject({ username: 'newbie01', accountNo: expect.stringMatching(/^5001-20-\d{6}$/) });
    expect((await step('/complete', { password: 'newbie-pass-1', accountPin: '1234' })).body.error).toBe('ALREADY_DONE');

    const login = await call(server, 'POST', '/auth/login', { username: 'newbie01', password: 'newbie-pass-1' });
    expect(login.status).toBe(200);
    const acct = await call(server, 'GET', '/account', undefined, { authorization: `Bearer ${login.body.accessToken as string}` });
    expect(acct.body).toMatchObject({ cash: 10_000_000, accountNo: done.body.accountNo, positions: [] });
  });

  it('토큰이 틀리면 신청서가 없는 것과 같다(404), 이어서 진행하면 단계가 남아 있다', async () => {
    const server = await start();
    const { id, token: appToken } = (await call(server, 'POST', '/account-open')).body as { id: string; token: string };
    expect((await call(server, 'GET', `/account-open/${id}`, undefined, { 'x-application-token': 'wrong' })).status).toBe(404);
    await call(server, 'POST', `/account-open/${id}/terms`, { required: true, privacy: true }, { 'x-application-token': appToken });
    const resumed = await call(server, 'GET', `/account-open/${id}`, undefined, { 'x-application-token': appToken });
    expect(resumed.body.step).toBe('profile');
  });

  it('가리기 규칙', () => {
    expect(maskName('홍길동')).toBe('홍*동');
    expect(maskName('남궁민수')).toBe('남**수');
    expect(maskName('이산')).toBe('이*');
    expect(maskBirth('19900101')).toBe('1990-**-**');
    expect(maskPhone('01012345678')).toBe('010-****-5678');
  });
});

describe('종목 120개', () => {
  it('기본 종목은 핵심 5 + 추가 115, 코드·이름이 겹치지 않고 기준가는 호가단위에 맞다', async () => {
    const { SYMBOLS, generatedSymbols } = await import('../src/market/symbols.js');
    const { roundToTick } = await import('../src/core.js');
    const isOnTick = (price: number) => roundToTick(price, 'down') === price;
    expect(SYMBOLS).toHaveLength(120);
    expect(new Set(SYMBOLS.map((s) => s.code)).size).toBe(120);
    expect(new Set(SYMBOLS.map((s) => s.name)).size).toBe(120);
    expect(SYMBOLS.every((s) => isOnTick(s.basePrice))).toBe(true);
    // 결정적: 다시 만들어도 같다
    expect(generatedSymbols(115)).toEqual(SYMBOLS.slice(5));
  });
});
