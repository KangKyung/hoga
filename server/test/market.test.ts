import { describe, expect, it } from 'vitest';

import { InMemoryBus } from '../src/bus.js';
import { Market } from '../src/market/market.js';
import { CORE_SYMBOLS } from '../src/market/symbols.js';
import { Metrics } from '../src/metrics.js';
import type { DeltaMessage, SnapshotMessage } from '../src/protocol.js';

/** 결정적 난수(테스트 재현용) */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

function setup(dropSeqRate = 0) {
  const bus = new InMemoryBus();
  const metrics = new Metrics();
  const market = new Market(bus, metrics, { dropSeqRate, random: seeded(7), symbols: CORE_SYMBOLS });
  const deltas: DeltaMessage[] = [];
  bus.subscribeAll((_symbol, kind, payload) => {
    if (kind === 'book') deltas.push(JSON.parse(payload) as DeltaMessage);
  });
  return { market, metrics, deltas };
}

/** 스냅샷 + 변경분을 클라이언트처럼 적용해 본다 */
function applyAll(snap: SnapshotMessage, deltas: DeltaMessage[]) {
  const bids = new Map(snap.bids);
  const asks = new Map(snap.asks);
  let seq = snap.seq;
  for (const d of deltas) {
    if (d.sym !== snap.sym || d.seq <= seq) continue;
    expect(d.seq).toBe(seq + 1);
    const book = d.side === 'B' ? bids : asks;
    if (d.qty === 0) book.delete(d.px);
    else book.set(d.px, d.qty);
    seq = d.seq;
  }
  const sorted = (m: Map<number, number>, desc: boolean) =>
    [...m.entries()].sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]));
  return { seq, bids: sorted(bids, true), asks: sorted(asks, false) };
}

describe('Market', () => {
  it('종목별 seq가 1씩 빠짐없이 증가한다', () => {
    const { market, deltas } = setup();
    market.warmUp(300);
    const bySymbol = new Map<string, number[]>();
    for (const d of deltas) bySymbol.set(d.sym, [...(bySymbol.get(d.sym) ?? []), d.seq]);
    expect(bySymbol.size).toBe(5);
    for (const seqs of bySymbol.values()) {
      seqs.forEach((seq, i) => expect(seq).toBe(i + 1));
    }
  });

  it('스냅샷 + 이후 변경분 = 최신 스냅샷 (클라이언트 재구성 검증)', () => {
    const { market, deltas } = setup();
    market.warmUp(50);
    const start = market.snapshot('000001', 1000);
    const from = deltas.length;
    market.warmUp(200);
    const rebuilt = applyAll(start, deltas.slice(from));
    const latest = market.snapshot('000001', 1000);
    expect(rebuilt.seq).toBe(latest.seq);
    expect(rebuilt.bids).toEqual(latest.bids);
    expect(rebuilt.asks).toEqual(latest.asks);
  });

  it('매수 최우선가는 항상 매도 최우선가보다 낮다', () => {
    const { market } = setup();
    market.warmUp(500);
    for (const s of market.list()) {
      const snap = market.snapshot(s.code, 1);
      if (snap.bids[0] && snap.asks[0]) expect(snap.bids[0][0]).toBeLessThan(snap.asks[0][0]);
    }
  });

  it('장애 주입: 일부 변경분을 빠뜨려도 seq는 증가한다(클라이언트가 gap을 감지할 수 있게)', () => {
    const { market, metrics, deltas } = setup(0.2);
    market.warmUp(200);
    const dropped = ['000001', '000002', '000003', '000004', '000005']
      .map((sym) => metrics.get('hoga_market_deltas_dropped_total', { sym }))
      .reduce((a, b) => a + b, 0);
    expect(dropped).toBeGreaterThan(0);
    const seqs = deltas.filter((d) => d.sym === '000001').map((d) => d.seq);
    const gaps = seqs.filter((seq, i) => i > 0 && seq !== seqs[i - 1]! + 1).length;
    expect(gaps).toBeGreaterThan(0);
  });

  it('호가단위가 틀린 주문은 C++ 규칙으로 거부되고 변경분을 내지 않는다', () => {
    const { market, deltas } = setup();
    const result = market.submit('000001', { side: 'bid', type: 'limit', price: 71_250, qty: 1 });
    expect(result.status).toBe('REJECTED');
    expect(result.reject).toBe('OFF_TICK');
    expect(deltas).toHaveLength(0);
  });
});
