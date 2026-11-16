import {JsBook} from '../src/bench/jsBook';
import {PerfCollector} from '../src/bench/perfMeter';
import {formatResult, summarize} from '../src/screens/BenchScreen';

jest.mock('../specs/NativeHogaCore', () => ({__esModule: true, default: {}}));

const snap = (seq: number) =>
  JSON.stringify({
    t: 'snap',
    sym: '000001',
    seq,
    ts: 0,
    bids: [
      [100, 1],
      [90, 2],
    ],
    asks: [
      [110, 3],
      [120, 4],
    ],
  });
const delta = (seq: number, side: 'B' | 'A', px: number, qty: number) =>
  JSON.stringify({t: 'delta', sym: '000001', seq, ts: 0, side, px, qty});

describe('JsBook (JS-routed comparison path)', () => {
  it('applies a snapshot and in-order deltas with the same rules as the C++ BookSync', () => {
    const book = new JsBook('000001', () => 5);
    expect(book.applyRaw(delta(1, 'B', 100, 9))).toBe('ignored'); // 스냅샷 전
    expect(book.applyRaw(snap(10))).toBe('applied');
    expect(book.applyRaw(delta(11, 'B', 95, 7))).toBe('applied');
    expect(book.applyRaw(delta(12, 'A', 110, 0))).toBe('applied'); // 0 = 삭제
    expect(book.applyRaw(delta(12, 'A', 110, 5))).toBe('ignored'); // 중복
    const view = book.view(2);
    expect(view).toEqual({
      subscribed: true,
      session: {phase: '', mode: '', viKind: '', viUntil: 0, viRef: 0, expPrice: 0, expQty: 0},
      seq: 12,
      sync: 'live',
      bids: [
        [100, 1],
        [95, 7],
      ],
      asks: [[120, 4]],
      lastUpdateMs: 5,
    });
  });

  it('stops on a gap until the next snapshot', () => {
    const book = new JsBook('000001');
    book.applyRaw(snap(10));
    expect(book.applyRaw(delta(12, 'B', 95, 7))).toBe('gap');
    expect(book.view(5).sync).toBe('resyncing');
    expect(book.applyRaw(delta(13, 'B', 96, 7))).toBe('ignored');
    expect(book.gaps).toBe(1);
    book.applyRaw(snap(20));
    expect(book.applyRaw(delta(21, 'B', 96, 7))).toBe('applied');
  });

  it('ignores other symbols, trades and malformed text', () => {
    const book = new JsBook('000001');
    expect(book.applyRaw('{"t":"delta","sym":"000002","seq":1}')).toBe('ignored');
    expect(book.applyRaw('{"t":"trade","sym":"000001","ts":0,"px":1,"qty":1,"aggr":"B"}')).toBe('trade');
    expect(book.applyRaw('not json')).toBe('ignored');
  });
});

describe('PerfCollector', () => {
  it('turns counts into per-second values and resets', () => {
    const c = new PerfCollector();
    for (let i = 0; i < 30; i++) c.frame();
    c.lag(2);
    c.lag(-1); // 이르게 불린 타이머는 0으로
    c.lag(40);
    c.count('renders', 10);
    c.count('bridged');
    expect(c.flush(500)).toEqual({jsFps: 60, lagAvgMs: 14, lagMaxMs: 40, counters: {renders: 20, bridged: 2}});
    expect(c.flush(1000)).toEqual({jsFps: 0, lagAvgMs: 0, lagMaxMs: 0, counters: {}});
  });

  it('summarizes a run: averages, but the worst lag is kept', () => {
    const r = summarize('js', [
      {jsFps: 60, lagAvgMs: 2, lagMaxMs: 10, counters: {renders: 100, bridged: 900, received: 1000}},
      {jsFps: 40, lagAvgMs: 6, lagMaxMs: 80, counters: {renders: 50, bridged: 1100}},
    ]);
    expect(r).toEqual({mode: 'js', seconds: 2, jsFps: 50, lagAvgMs: 4, lagMaxMs: 80, renders: 75, bridged: 1000, received: 500});
    expect(formatResult(r)).toBe('mode=js sec=2 fps=50 lagAvg=4 lagMax=80 renders=75 bridged=1000 received=500');
  });
});
