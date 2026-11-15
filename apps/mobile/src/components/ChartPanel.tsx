import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View, type NativeSyntheticEvent} from 'react-native';

import HogaChartView, {type CrosshairEvent} from '../../specs/HogaChartViewNativeComponent';
import {track} from '../analytics/analytics';
import {useI18n} from '../i18n';
import {colors, formatPrice, mono} from '../theme';

const INTERVALS = [
  {label: 'chart.1m', name: '1m', ms: 60_000},
  {label: 'chart.5m', name: '5m', ms: 300_000},
] as const;

/**
 * 네이티브 캔들 차트(Fabric) + 조작 UI.
 * 차트 데이터는 JS를 지나가지 않는다: 네이티브 뷰가 C++ 봉을 직접 읽어 그린다.
 * JS는 무엇을 그릴지(종목·구간·옵션)와 십자선이 짚은 봉 정보만 다룬다.
 */
export function ChartPanel({symbol}: {symbol: string}) {
  const {t} = useI18n();
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
            onPress={() => {
              setIntervalMs(i.ms);
              track('change_chart_interval', {symbol, interval: i.name});
            }}
            style={[styles.chip, intervalMs === i.ms && styles.chipActive]}>
            <Text style={[styles.chipText, intervalMs === i.ms && styles.chipTextActive]}>{t(i.label)}</Text>
          </Pressable>
        ))}
        <Pressable testID="toggleMA" onPress={() => setShowMA(v => !v)} style={[styles.chip, showMA && styles.chipActive]}>
          <Text style={[styles.chipText, showMA && styles.chipTextActive]}>{t('chart.ma')}</Text>
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
            {t('chart.ohlc', {
              time: new Date(picked.start).toTimeString().slice(0, 5),
              open: formatPrice(picked.open),
              high: formatPrice(picked.high),
              low: formatPrice(picked.low),
              close: formatPrice(picked.close),
              volume: formatPrice(picked.volume),
            })}
          </Text>
        ) : (
          <Text style={styles.hint} numberOfLines={1}>
            {t('chart.hint')}
          </Text>
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
  card: {
    backgroundColor: colors.card,
    borderRadius: 10,
    overflow: 'hidden',
    paddingBottom: 4,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingTop: 10,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.bg,
  },
  chipActive: {backgroundColor: colors.accent},
  chipText: {fontSize: 12, fontWeight: '600', color: colors.sub},
  chipTextActive: {color: '#fff'},
  legend: {marginLeft: 'auto', fontSize: 11},
  ma5: {color: '#C27A00'},
  ma20: {color: '#7B3FBF'},
  // 태국어는 글자 위아래로 성조 기호가 붙어 같은 글자 크기에서도 더 높다 → 높이를 고정하지 않고 최소값만
  readout: {
    minHeight: 24,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 2,
  },
  readoutText: {fontSize: 11, color: colors.text},
  hint: {fontSize: 11, color: colors.mute},
  chart: {height: 320, marginHorizontal: 4},
});
