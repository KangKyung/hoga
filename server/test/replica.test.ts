import { describe, expect, it } from 'vitest';

import { BookReplica } from '../src/gateway/replica.js';

describe('BookReplica — market 재시작', () => {
  it('다시 받은 스냅샷의 seq가 줄었으면 재시작으로 알리고 새 장부로 바꾼다', async () => {
    let seq = 5_000;
    let bid = 71_200;
    const restarts: number[] = [];
    const replica = new BookReplica(
      'http://market',
      async (url) => {
        if (url.endsWith('/symbols')) return [{ code: '000001' }];
        if (url.endsWith('/market/status')) return [];
        return { t: 'snap', sym: '000001', seq, ts: 0, bids: [[bid, 10]], asks: [] };
      },
      () => 0,
      () => restarts.push(seq),
    );
    await replica.start();
    expect(replica.snapshot('000001').seq).toBe(5_000);

    // market 재시작: seq가 처음부터. 버스로 온 작은 seq 변경분은 그대로면 버려진다
    seq = 3;
    bid = 70_000;
    replica.onBook('000001', JSON.stringify({ t: 'delta', sym: '000001', seq: 1, side: 'B', px: 70_000, qty: 1, ts: 0 }));
    expect(replica.snapshot('000001').seq).toBe(5_000);

    // market-started 알림 → 다시 받기 → seq가 줄었으니 재시작
    replica.resyncAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(restarts).toEqual([3]);
    expect(replica.snapshot('000001')).toMatchObject({ seq: 3, bids: [[70_000, 10]] });
    replica.onBook('000001', JSON.stringify({ t: 'delta', sym: '000001', seq: 4, side: 'B', px: 70_000, qty: 7, ts: 0 }));
    expect(replica.snapshot('000001')).toMatchObject({ seq: 4, bids: [[70_000, 7]] });
  });
});
