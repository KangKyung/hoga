/**
 * M0 확인 화면: JS → C++ TurboModule → hoga-core 호출이 iOS·Android에서 같은 값을 내는지 본다.
 */
import React, {useMemo} from 'react';
import {Platform, ScrollView, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import NativeHogaCore from './specs/NativeHogaCore';

const SAMPLE_PRICES = [1_999, 2_000, 4_999, 5_000, 19_999, 20_000, 49_999, 50_000, 199_999, 200_000, 499_999, 500_000];

function App(): React.JSX.Element {
  const version = useMemo(() => NativeHogaCore.coreVersion(), []);
  const rows = useMemo(
    () => SAMPLE_PRICES.map(price => ({price, tick: NativeHogaCore.tickSize(price)})),
    [],
  );
  const invalidInput = useMemo(() => {
    try {
      NativeHogaCore.tickSize(1000.5);
      return '오류 없음 (잘못됨)';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Hoga · M0</Text>
          <Text style={styles.caption}>JS → C++ TurboModule → hoga-core</Text>

          <View style={styles.card}>
            <Text style={styles.label}>Platform</Text>
            <Text testID="platform">{Platform.OS}</Text>
            <Text style={styles.label}>coreVersion()</Text>
            <Text testID="coreVersion" style={styles.value}>{version}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>tickSize(price)</Text>
            {rows.map(({price, tick}) => (
              <View key={price} style={styles.row}>
                <Text style={styles.mono}>{price.toLocaleString('ko-KR')}원</Text>
                <Text testID={`tick-${price}`} style={styles.mono}>
                  {tick.toLocaleString('ko-KR')}원
                </Text>
              </View>
            ))}
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>tickSize(1000.5) → JS 오류</Text>
            <Text testID="invalidInput" style={styles.mono}>{invalidInput}</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#f3f5f7'},
  content: {padding: 16, gap: 12},
  title: {fontSize: 24, fontWeight: '700', color: '#123c69'},
  caption: {color: '#4a5663'},
  card: {backgroundColor: '#fff', borderRadius: 8, padding: 12, gap: 4},
  label: {fontSize: 12, color: '#7b8692', marginTop: 4},
  value: {fontSize: 18, fontWeight: '600'},
  row: {flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2},
  mono: {fontFamily: Platform.select({ios: 'Menlo', android: 'monospace'})},
});

export default App;
