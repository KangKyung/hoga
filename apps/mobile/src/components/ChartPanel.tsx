import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View, type NativeSyntheticEvent} from 'react-native';

import HogaChartView, {type CrosshairEvent} from '../../specs/HogaChartViewNativeComponent';
import {colors, formatPrice, mono} from '../theme';

const INTERVALS = [
  {label: '1분', ms: 60_000},
  {label: '5분', ms: 300_000},
] as const;

/**
 * 네이티브 캔들 차트(Fabric) + 조작 UI.
 * 차트 데이터는 JS를 지나가지 않는다: 네이티브 뷰가 C++ 봉을 직접 읽어 그린다.
 * JS는 무엇을 그릴지(종목·구간·옵션)와 십자선이 짚은 봉 정보만 다룬다.
 */
export function ChartPanel({symbol}: {symbol: string}) {
  const [intervalMs, setIntervalMs] = useState<number>(60_000);
  const [showMA, setShowMA] = useState(true);
  const [picked, setPicked] = useState<CrosshairEvent | null>(null);

  const onCrosshair = (e: NativeSyntheticEvent<CrosshairEvent>) => {
    setPicked(e.nativeEvent.active ? e.nativeEvent : null);
  };

  return (
    <View style={styles.card}>
      <View style={styles.toolbar}>
        {INTERVALS.map(i => (
          <Pressable
            key={i.ms}
            testID={`interval-${i.ms}`}
            onPress={() => setIntervalMs(i.ms)}
            style={[styles.chip, intervalMs === i.ms && styles.chipActive]}>
            <Text style={[styles.chipText, intervalMs === i.ms && styles.chipTextActive]}>{i.label}</Text>
          </Pressable>
        ))}
        <Pressable testID="toggleMA" onPress={() => setShowMA(v => !v)} style={[styles.chip, showMA && styles.chipActive]}>
          <Text style={[styles.chipText, showMA && styles.chipTextActive]}>이동평균</Text>
        </Pressable>
        {showMA ? (
          <Text style={styles.legend}>
            <Text style={styles.ma5}>━ 5</Text> <Text style={styles.ma20}>━ 20</Text>
          </Text>
        ) : null}
      </View>

      <View style={styles.readout}>
        {picked ? (
          <Text testID="crosshair" style={[styles.readoutText, mono]}>
            {new Date(picked.start).toTimeString().slice(0, 5)} 시 {formatPrice(picked.open)} 고 {formatPrice(picked.high)} 저{' '}
            {formatPrice(picked.low)} 종 {formatPrice(picked.close)} · {formatPrice(picked.volume)}주
          </Text>
        ) : (
          <Text style={styles.hint}>핀치: 확대·축소 · 가로 드래그: 과거 보기 · 길게 누르기: 봉 정보</Text>
        )}
      </View>

      <HogaChartView
        testID="chart"
        style={styles.chart}
        symbol={symbol}
        intervalMs={intervalMs}
        initialBars={60}
        showVolume
        showMA={showMA}
        onCrosshair={onCrosshair}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {backgroundColor: colors.card, borderRadius: 10, overflow: 'hidden', paddingBottom: 4},
  toolbar: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingTop: 10},
  chip: {paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.bg},
  chipActive: {backgroundColor: colors.accent},
  chipText: {fontSize: 12, fontWeight: '600', color: colors.sub},
  chipTextActive: {color: '#fff'},
  legend: {marginLeft: 'auto', fontSize: 11},
  ma5: {color: '#C27A00'},
  ma20: {color: '#7B3FBF'},
  readout: {height: 22, justifyContent: 'center', paddingHorizontal: 12},
  readoutText: {fontSize: 11, color: colors.text},
  hint: {fontSize: 11, color: colors.mute},
  chart: {height: 320, marginHorizontal: 4},
});
