/**
 * Hoga — M3: 로그인 · 주문 · 보안.
 * 시세: 소켓(iOS URLSession / Android OkHttp) → C++ MarketClient → JS가 화면 주기로 끌어옴
 * 주문: 멱등 키 + 타임아웃 시 조회로 확정, 체결 알림은 C++ → JS 이벤트
 */
import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import {fetchSymbols, type SymbolInfo} from './src/api/symbols';
import {session, useSession} from './src/auth/session';
import {SERVER} from './src/config';
import {hogaCore, type OrderEvent} from './src/native/hogaCore';
import {deviceGuard} from './src/native/security';
import {orderService} from './src/orders/orderService';
import {LoginScreen} from './src/screens/LoginScreen';
import {QuoteScreen} from './src/screens/QuoteScreen';
import {WatchlistScreen} from './src/screens/WatchlistScreen';
import {colors, formatPrice} from './src/theme';

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

/** 화면 위쪽에 잠깐 뜨는 알림(체결·미확정 주문 정리 결과) */
function useBanner() {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (message: string) => {
    setText(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), 3500);
  };
  return {text, show};
}

function Main({userName}: {userName: string}) {
  const {symbols, error} = useSymbols();
  const [selected, setSelected] = useState<SymbolInfo | null>(null);
  const banner = useBanner();

  useEffect(() => {
    if (symbols.length) hogaCore.subscribe(symbols.map(s => s.code));
  }, [symbols]);

  // 로그인 직후: 지난번에 확정하지 못한 주문을 서버 조회로 정리
  useEffect(() => {
    orderService
      .reconcile()
      .then(r => {
        const parts = [];
        if (r.confirmed.length) parts.push(`접수 확인 ${r.confirmed.length}건`);
        if (r.notSent.length) parts.push(`전송되지 않은 주문 ${r.notSent.length}건(다시 보내지 않음)`);
        if (r.stillUnknown.length) parts.push(`아직 확인 중 ${r.stillUnknown.length}건`);
        if (parts.length) banner.show(`이전 주문 정리: ${parts.join(' · ')}`);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 체결 알림(서버 → C++ → JS 이벤트)
  useEffect(() => {
    const sub = hogaCore.onOrderEvent((e: OrderEvent) => {
      if (e.fill) {
        banner.show(`체결 ${e.side === 'bid' ? '매수' : '매도'} ${formatPrice(e.fill.price)} × ${formatPrice(e.fill.qty)}주`);
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      {selected ? (
        <QuoteScreen symbol={selected} onBack={() => setSelected(null)} />
      ) : (
        <WatchlistScreen userName={userName} symbols={symbols} error={error} onSelect={setSelected} />
      )}
      {banner.text ? (
        <View testID="banner" style={styles.banner} pointerEvents="none">
          <Text style={styles.bannerText}>{banner.text}</Text>
        </View>
      ) : null}
    </View>
  );
}

function App(): React.JSX.Element {
  const state = useSession();

  useEffect(() => {
    // 시세는 로그인과 무관하게 연결, 로그인하면 세션이 토큰을 넘겨 주문 알림까지 받는다
    hogaCore.connect(SERVER.ws, SERVER.http);
    deviceGuard.setSecureScreen(true); // 잔고·주문 화면이 캡처·앱 전환기에 남지 않게
    session.restore();
    return () => hogaCore.disconnect();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        {state.status === 'loading' ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : state.status === 'signedIn' ? (
          <Main userName={state.user.name} />
        ) : (
          <LoginScreen state={state} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  banner: {
    position: 'absolute',
    top: 8,
    left: 16,
    right: 16,
    backgroundColor: colors.text,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bannerText: {color: '#fff', fontWeight: '600'},
});

export default App;
