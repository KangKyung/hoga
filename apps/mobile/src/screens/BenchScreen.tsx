/**
 * "JS 경유 vs C++ 직접" 비교 실험 화면(설정 → 성능 실험).
 *
 * 같은 호가 표(매도 10 + 매수 10)를 두 경로로 그린다.
 * - C++ 직접: 소켓 → C++ MarketClient가 장부 유지, JS는 초당 12번 getBook으로 끌어온다(앱의 실제 경로).
 * - JS 경유: 소켓 → C++ → 메시지마다 JS 이벤트 → JSON.parse → JS 장부 → setState(일반적인 RN 방식).
 *
 * 측정값(JS FPS, 이벤트 루프 지연, 초당 렌더·메시지)은 화면에 testID로 내보내 Appium이 읽는다.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import {JsBook} from '../bench/jsBook';
import {PerfCollector, usePerfMeter, type PerfSample} from '../bench/perfMeter';
import {SERVER} from '../config';
import {useBook} from '../hooks/market';
import {useI18n} from '../i18n';
import {hogaCore, type BookView} from '../native/hogaCore';
import {colors, formatPrice, mono} from '../theme';

export type BenchMode = 'cpp' | 'js';
const DEPTH = 10;
const RUN_SECONDS = 10;

export interface BenchResult {
  mode: BenchMode;
  seconds: number;
  jsFps: number;
  lagAvgMs: number;
  lagMaxMs: number;
  renders: number;
  bridged: number;
  received: number;
}

/** 측정 구간의 초당 값들을 평균(지연 최대는 최댓값) */
export function summarize(mode: BenchMode, samples: PerfSample[]): BenchResult {
  const avg = (pick: (s: PerfSample) => number) =>
    samples.length ? Math.round(samples.reduce((a, s) => a + pick(s), 0) / samples.length) : 0;
  return {
    mode,
    seconds: samples.length,
    jsFps: avg(s => s.jsFps),
    lagAvgMs: avg(s => s.lagAvgMs),
    lagMaxMs: samples.reduce((m, s) => Math.max(m, s.lagMaxMs), 0),
    renders: avg(s => s.counters.renders ?? 0),
    bridged: avg(s => s.counters.bridged ?? 0),
    received: avg(s => s.counters.received ?? 0),
  };
}

export const formatResult = (r: BenchResult) =>
  `mode=${r.mode} sec=${r.seconds} fps=${r.jsFps} lagAvg=${r.lagAvgMs} lagMax=${r.lagMaxMs} renders=${r.renders} bridged=${r.bridged} received=${r.received}`;

export function BenchScreen({symbol, onBack}: {symbol: string; onBack: () => void}) {
  const {t} = useI18n();
  const collector = useMemo(() => new PerfCollector(), []);
  const sample = usePerfMeter(collector);
  const [mode, setMode] = useState<BenchMode>('cpp');
  const [running, setRunning] = useState<{mode: BenchMode; samples: PerfSample[]} | null>(null);
  const [result, setResult] = useState<BenchResult | null>(null);

  // C++가 실제로 받은 메시지 수(두 모드 공통, 서버 부하 확인용). 1초마다 직전 1초의 증가분을 넣어
  // 다음 측정값에 실린다(1초 늦게 보이는 대신 측정 자체가 렌더를 늘리지 않는다).
  const lastMessages = useRef(hogaCore.getStats().messages);
  useEffect(() => {
    const now = hogaCore.getStats().messages;
    collector.count('received', Math.max(0, now - lastMessages.current));
    lastMessages.current = now;
  }, [sample, collector]);

  // 측정: 시작 직후 1초는 버리고 RUN_SECONDS초 모은다
  useEffect(() => {
    if (!running) return;
    setRunning(r => (r ? {...r, samples: [...r.samples, sample]} : r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample]);
  useEffect(() => {
    if (!running || running.samples.length < RUN_SECONDS + 1) return;
    const r = summarize(running.mode, running.samples.slice(1));
    console.log('[bench]', JSON.stringify(r));
    setResult(r);
    setRunning(null);
  }, [running]);

  const start = () => {
    setResult(null);
    setRunning({mode, samples: []});
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable testID="back" onPress={onBack} hitSlop={12} disabled={!!running}>
          <Text style={styles.back}>{t('quote.back')}</Text>
        </Pressable>
        <Text style={styles.title}>{t('bench.title')}</Text>
        <View style={styles.spacer} />
      </View>

      <View style={styles.modes}>
        {(['cpp', 'js'] as const).map(m => (
          <Pressable
            key={m}
            testID={`bench-mode-${m}`}
            accessibilityRole="radio"
            accessibilityState={{selected: m === mode}}
            disabled={!!running}
            onPress={() => setMode(m)}
            style={[styles.mode, m === mode && styles.modeOn]}>
            <Text style={[styles.modeText, m === mode && styles.modeTextOn]}>
              {t(m === 'cpp' ? 'bench.modeCpp' : 'bench.modeJs')}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.meters}>
        <Meter testID="bench-fps" label={t('bench.jsFps')} value={String(sample.jsFps)} />
        <Meter testID="bench-lag" label={t('bench.lag')} value={`${sample.lagAvgMs} / ${sample.lagMaxMs}`} />
        <Meter testID="bench-renders" label={t('bench.renders')} value={String(sample.counters.renders ?? 0)} />
        <Meter testID="bench-rate" label={t('bench.received')} value={formatPrice(sample.counters.received ?? 0)} />
      </View>

      <Pressable testID="bench-run" style={[styles.run, running && styles.runBusy]} disabled={!!running} onPress={start}>
        <Text style={styles.runText}>
          {running
            ? t('bench.running', {n: Math.max(0, RUN_SECONDS + 1 - running.samples.length)})
            : t('bench.run', {n: RUN_SECONDS})}
        </Text>
      </Pressable>
      <Text testID="bench-result" style={[styles.result, mono]} selectable>
        {result ? formatResult(result) : t('bench.hint')}
      </Text>

      <ScrollView style={styles.bookScroll}>
        {mode === 'cpp' ? (
          <CppBook symbol={symbol} collector={collector} />
        ) : (
          <JsRoutedBook symbol={symbol} collector={collector} />
        )}
      </ScrollView>
    </View>
  );
}

function Meter({testID, label, value}: {testID: string; label: string; value: string}) {
  return (
    <View style={styles.meter}>
      <Text style={styles.meterLabel}>{label}</Text>
      <Text testID={testID} style={[styles.meterValue, mono]}>
        {value}
      </Text>
    </View>
  );
}

/** 앱의 실제 경로: C++가 장부를 갖고, JS는 화면 주기로 끌어온다 */
function CppBook({symbol, collector}: {symbol: string; collector: PerfCollector}) {
  const book = useBook(symbol, DEPTH);
  return <BookTable book={book} collector={collector} />;
}

/** 비교용 경로: 메시지마다 JS로 넘어와 JS가 장부를 갱신하고 다시 그린다 */
function JsRoutedBook({symbol, collector}: {symbol: string; collector: PerfCollector}) {
  const jsBook = useMemo(() => new JsBook(symbol), [symbol]);
  const [book, setBook] = useState<BookView>(() => jsBook.view(DEPTH));

  useEffect(() => {
    let resyncing = false;
    const resync = () => {
      if (resyncing) return;
      resyncing = true;
      fetch(`${SERVER.http}/book/${symbol}?depth=50`)
        .then(r => r.text())
        .then(text => {
          jsBook.applyRaw(text);
          setBook(jsBook.view(DEPTH));
        })
        .catch(() => {})
        .finally(() => {
          resyncing = false;
        });
    };
    const sub = hogaCore.onMarketMessage(json => {
      collector.count('bridged');
      const r = jsBook.applyRaw(json);
      if (r === 'applied') setBook(jsBook.view(DEPTH));
      else if (r === 'gap') resync();
    });
    hogaCore.setMarketTap(true);
    resync(); // 이미 구독 중이라 스냅샷이 다시 오지 않으므로 처음 한 번 받아 둔다
    return () => {
      hogaCore.setMarketTap(false);
      sub.remove();
    };
  }, [symbol, jsBook, collector]);

  return <BookTable book={book} collector={collector} />;
}

function BookTable({book, collector}: {book: BookView; collector: PerfCollector}) {
  collector.count('renders');
  const maxQty = Math.max(1, ...book.asks.map(l => l[1]), ...book.bids.map(l => l[1]));
  const asks = [...book.asks].reverse();
  return (
    <View testID="bench-book">
      {asks.map(([price, qty]) => (
        <Row key={`a${price}`} price={price} qty={qty} maxQty={maxQty} ask />
      ))}
      {book.bids.map(([price, qty]) => (
        <Row key={`b${price}`} price={price} qty={qty} maxQty={maxQty} ask={false} />
      ))}
    </View>
  );
}

function Row({price, qty, maxQty, ask}: {price: number; qty: number; maxQty: number; ask: boolean}) {
  const width = `${Math.max(2, (qty / maxQty) * 100)}%` as const;
  return (
    <View style={[styles.row, {backgroundColor: ask ? colors.downSoft : colors.upSoft}]}>
      <View style={[styles.bar, {width, backgroundColor: ask ? colors.downSoft : colors.upSoft}]} />
      <Text style={[styles.price, mono, {color: ask ? colors.down : colors.up}]}>{formatPrice(price)}</Text>
      <Text style={[styles.qty, mono]}>{formatPrice(qty)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  back: {fontSize: 16, color: colors.accent, fontWeight: '600'},
  title: {fontSize: 17, fontWeight: '700', color: colors.text},
  spacer: {width: 48},
  modes: {flexDirection: 'row', gap: 8, paddingHorizontal: 16},
  mode: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: 'center',
  },
  modeOn: {borderColor: colors.accent, backgroundColor: colors.accent},
  modeText: {fontSize: 14, fontWeight: '600', color: colors.sub},
  modeTextOn: {color: '#fff'},
  meters: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 16, paddingBottom: 8},
  meter: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: colors.card,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  meterLabel: {fontSize: 12, color: colors.mute},
  meterValue: {fontSize: 20, fontWeight: '700', color: colors.text},
  run: {marginHorizontal: 16, paddingVertical: 12, borderRadius: 8, backgroundColor: colors.accent, alignItems: 'center'},
  runBusy: {opacity: 0.6},
  runText: {color: '#fff', fontWeight: '700', fontSize: 15},
  result: {fontSize: 11, color: colors.sub, paddingHorizontal: 16, paddingVertical: 8},
  bookScroll: {flex: 1, marginHorizontal: 16},
  row: {flexDirection: 'row', alignItems: 'center', height: 26, paddingHorizontal: 10, marginBottom: 1},
  bar: {position: 'absolute', right: 0, top: 0, bottom: 0},
  price: {flex: 1, fontSize: 14, fontWeight: '600'},
  qty: {fontSize: 13, color: colors.text},
});
