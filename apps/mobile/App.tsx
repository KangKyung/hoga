/**
 * Hoga — M2: 실시간 호가.
 * 소켓(iOS URLSession / Android OkHttp) → C++ MarketClient → JS는 화면 주기로 끌어와 그린다.
 */
import React, {useEffect, useState} from 'react';
import {StatusBar, StyleSheet} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import {fetchSymbols, type SymbolInfo} from './src/api/symbols';
import {SERVER} from './src/config';
import {hogaCore} from './src/native/hogaCore';
import {QuoteScreen} from './src/screens/QuoteScreen';
import {WatchlistScreen} from './src/screens/WatchlistScreen';
import {colors} from './src/theme';

function useSymbols() {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetchSymbols(controller.signal)
        .then(list => {
          setSymbols(list);
          setError(null);
        })
        .catch(e => {
          if (controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          timer = setTimeout(load, 2000); // 서버가 늦게 떠도 다시 시도
        });
    };
    load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return {symbols, error};
}

function App(): React.JSX.Element {
  const {symbols, error} = useSymbols();
  const [selected, setSelected] = useState<SymbolInfo | null>(null);

  useEffect(() => {
    hogaCore.connect(SERVER.ws, SERVER.http);
    return () => hogaCore.disconnect();
  }, []);

  useEffect(() => {
    if (symbols.length) hogaCore.subscribe(symbols.map(s => s.code));
  }, [symbols]);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        {selected ? (
          <QuoteScreen symbol={selected} onBack={() => setSelected(null)} />
        ) : (
          <WatchlistScreen symbols={symbols} error={error} onSelect={setSelected} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
});

export default App;
