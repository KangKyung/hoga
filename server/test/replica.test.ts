import { describe, expect, it } from 'vitest';

import { BookReplica } from '../src/gateway/replica.js';

/** market 흉내: 세대(epoch)·종목별 seq·매수 1호가, 실패시킬 요청 수 */
function fakeMarket(symbols: string[]) {
  const m = {
    epoch: 'e1',
    seq: new Map(symbols.map((s) => [s, 5_000])),
    bid: new Map(symbols.map((s) => [s, 71_200])),
    failNext: new Map<string, number>(),
    fetch: async (url: string): Promise<unknown> => {
      if (url.endsWith('/readyz')) return { ready: true, epoch: m.epoch };
      if (url.endsWith('/symbols')) return symbols.map((code) => ({ code }));
      if (url.endsWith('/market/status')) return [];
      const sym = /\/book\/(\d+)/.exec(url)![1]!;
      const fails = m.failNext.get(sym) ?? 0;
      if (fails > 0) {
        m.failNext.set(sym, fails - 1);
        throw new Error('503');
      }
      return { t: 'snap', sym, seq: m.seq.get(sym), ts: 0, bids: [[m.bid.get(sym), 10]], asks: [] };
    },
  };
  return m;
}

describe('BookReplica — market 재시작', () => {
  it('세대가 바뀌면 seq가 우연히 이어져도 재시작으로 보고 새 장부로 바꾼다', async () => {
    const market = fakeMarket(['000001']);
    const restarts: number[] = [];
    const replica = new BookReplica('http://market', market.fetch, Date.now, () => restarts.push(1));
    await replica.start();

    // 새 market: seq가 마침 5001부터(옛 장부 위에 그대로 쌓일 수 있는 경우)
    market.epoch = 'e2';
    market.seq.set('000001', 5_001);
    market.bid.set('000001', 70_000);
    await replica.resyncAll();
    expect(restarts).toHaveLength(1);
    expect(replica.snapshot('000001')).toMatchObject({ seq: 5_001, bids: [[70_000, 10]] });

    // 세대가 같으면(버스 재구독 등) 끊지 않는다
    await replica.resyncAll();
    expect(restarts).toHaveLength(1);
  });

  it('일부 종목을 다시 받지 못했으면 모두 받을 때까지 기다렸다가 한 번만 재접속시킨다', async () => {
    const market = fakeMarket(['000001', '000002']);
    let liveAtRestart: boolean[] = [];
    const replica = new BookReplica('http://market', market.fetch, Date.now, () => {
      liveAtRestart = [replica.isLive('000001'), replica.isLive('000002')];
    });
    await replica.start();

    market.epoch = 'e2';
    market.seq.set('000001', 3);
    market.seq.set('000002', 4);
    market.failNext.set('000002', 1); // 첫 요청 실패 → 500ms 뒤 다시
    await replica.resyncAll();
    // 끊는 시점에는 모든 종목이 새 장부(재접속한 클라이언트가 옛 seq 스냅샷을 받지 않는다)
    expect(liveAtRestart).toEqual([true, true]);
    expect(replica.snapshot('000002').seq).toBe(4);
  });

  it('세대를 못 읽어도 다시 받은 seq가 줄었으면 재시작으로 본다', async () => {
    const market = fakeMarket(['000001']);
    const restarts: number[] = [];
    const replica = new BookReplica('http://market', market.fetch, Date.now, () => restarts.push(1));
    await replica.start();
    const original = market.fetch;
    market.seq.set('000001', 3);
    const replica2Fetch = async (url: string) => (url.endsWith('/readyz') ? Promise.reject(new Error('down')) : original(url));
    (replica as unknown as { fetchJson: typeof replica2Fetch }).fetchJson = replica2Fetch;
    await replica.resyncAll();
    expect(restarts).toHaveLength(1);
  });

  it('기다리는 동안 늦게 받은 종목의 seq 감소는 이번 재시작으로 끝난다(다음 평범한 재구독에서 다시 끊지 않는다)', async () => {
    const market = fakeMarket(['000001', '000002']);
    const restarts: number[] = [];
    const replica = new BookReplica('http://market', market.fetch, Date.now, () => restarts.push(1));
    await replica.start();

    market.epoch = 'e2';
    market.seq.set('000001', 3);
    market.seq.set('000002', 4);
    market.failNext.set('000002', 1); // 대기 중 재시도에서 seq 감소(5000 → 4)를 본다
    await replica.resyncAll();
    expect(restarts).toHaveLength(1);

    await replica.resyncAll(); // 같은 세대의 버스 재구독
    expect(restarts).toHaveLength(1);
  });

  it('15초 안에 받지 못한 종목은 나중에 live가 되면 그 종목 구독자만 다시 접속시킨다', async () => {
    const market = fakeMarket(['000001', '000002']);
    let clock = 0;
    const restarts: number[] = [];
    const late: string[] = [];
    // 시계를 부를 때마다 1초씩 흐르게 해 15초 마감을 바로 넘긴다
    const replica = new BookReplica('http://market', market.fetch, () => (clock += 1_000), () => restarts.push(1), (s) => late.push(s));
    await replica.start();

    market.epoch = 'e2';
    market.failNext.set('000002', 1_000);
    await replica.resyncAll();
    expect(restarts).toHaveLength(1);
    expect(replica.isLive('000002')).toBe(false);
    expect(late).toEqual([]);

    market.failNext.set('000002', 0);
    await new Promise((r) => setTimeout(r, 700));
    expect(replica.isLive('000002')).toBe(true);
    expect(late).toEqual(['000002']);
  });
});
