/**
 * Hoga — M5: 웹 화면 · 분석 · 현지화.
 * 시세: 소켓(iOS URLSession / Android OkHttp) → C++ MarketClient → JS가 화면 주기로 끌어옴
 * 주문: 멱등 키 + 타임아웃 시 조회로 확정, 체결 알림은 C++ → JS 이벤트
 * 차트: Fabric 네이티브 뷰가 C++ 봉을 직접 읽음
 * 웹: 종목정보(HTML/JS)·공지(AngularJS)를 웹뷰로 열고 검증된 브리지로만 주고받음
 */
import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import {track} from './src/analytics/analytics';
import {AppGate} from './src/appgate/AppGate';
import {fetchSymbols, type SymbolInfo} from './src/api/symbols';
import {session, useSession} from './src/auth/session';
import {SECURE_SCREEN, SERVER} from './src/config';
import {refreshFromServer, t, useI18n} from './src/i18n';
import {loadSavedLocale} from './src/i18n/persist';
import {startMarketLifecycle} from './src/market/subscriptions';
import {hogaCore, type OrderEvent} from './src/native/hogaCore';
import {deviceGuard} from './src/native/security';
import {orderService} from './src/orders/orderService';
import {AccountOpenScreen} from './src/screens/AccountOpenScreen';
import {AccountScreen} from './src/screens/AccountScreen';
import {BenchScreen} from './src/screens/BenchScreen';
import {LoginScreen} from './src/screens/LoginScreen';
import {NoticesScreen} from './src/screens/NoticesScreen';
import {QuoteScreen} from './src/screens/QuoteScreen';
import {SettingsScreen} from './src/screens/SettingsScreen';
import {WatchlistScreen} from './src/screens/WatchlistScreen';
import {colors, formatPrice} from './src/theme';

/** WS 인증 거절 → 토큰 갱신 최소 간격 */
const AUTH_RETRY_MS = 30_000;

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

type Route =
  | {name: 'watchlist'}
  | {name: 'quote'; symbol: SymbolInfo; from?: 'account'}
  | {name: 'account'}
  | {name: 'notices'}
  | {name: 'settings'}
  | {name: 'bench'};

function Main({userName}: {userName: string}) {
  useI18n(); // 언어가 바뀌면 다시 그린다
  const {symbols, error} = useSymbols();
  const [route, setRoute] = useState<Route>({name: 'watchlist'});
  const banner = useBanner();
  const home = () => setRoute({name: 'watchlist'});

  useEffect(() => {
    track('screen_view', {screen_name: route.name});
  }, [route.name]);

  // 시세 구독은 화면이 필요한 종목만(관심종목의 보이는 줄, 호가 화면, 주문 창) — src/market/subscriptions.ts

  // 로그인 직후: 지난번에 확정하지 못한 주문을 서버 조회로 정리
  useEffect(() => {
    orderService
      .reconcile()
      .then(r => {
        const parts = [];
        if (r.confirmed.length) parts.push(t('banner.reconcileConfirmed', {n: r.confirmed.length}));
        if (r.notSent.length) parts.push(t('banner.reconcileNotSent', {n: r.notSent.length}));
        if (r.lost.length) parts.push(t('banner.reconcileLost', {n: r.lost.length}));
        if (r.stillUnknown.length) parts.push(t('banner.reconcileUnknown', {n: r.stillUnknown.length}));
        if (parts.length) banner.show(t('banner.reconcile', {parts: parts.join(' · ')}));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 서버가 WS 인증을 거절하면(토큰 만료: 백그라운드에서 갱신 타이머가 늦은 경우 등) 토큰을 갱신해 다시 인증.
  // 새 토큰도 거절되는 상황(서버 간 비밀 키 불일치 등)에서 갱신이 끝없이 돌지 않게 30초에 한 번만
  useEffect(() => {
    let last = 0;
    const sub = hogaCore.onAuthRejected(() => {
      const now = Date.now();
      if (now - last < AUTH_RETRY_MS || session.getState().status !== 'signedIn') return;
      last = now;
      session.tokens.refresh().catch(() => {});
    });
    return () => sub.remove();
  }, []);

  // 체결 알림(서버 → C++ → JS 이벤트)
  useEffect(() => {
    const sub = hogaCore.onOrderEvent((e: OrderEvent) => {
      if (e.fill) {
        banner.show(
          t('banner.fill', {
            side: t(e.side === 'bid' ? 'common.buy' : 'common.sell'),
            price: formatPrice(e.fill.price),
            qty: formatPrice(e.fill.qty),
          }),
        );
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      {route.name === 'quote' ? (
        <QuoteScreen symbol={route.symbol} onBack={route.from === 'account' ? () => setRoute({name: 'account'}) : home} />
      ) : route.name === 'account' ? (
        <AccountScreen
          symbols={symbols}
          onBack={home}
          onSelectSymbol={symbol => setRoute({name: 'quote', symbol, from: 'account'})}
        />
      ) : route.name === 'notices' ? (
        <NoticesScreen onBack={home} />
      ) : route.name === 'settings' ? (
        <SettingsScreen onBack={home} onOpenBench={() => setRoute({name: 'bench'})} />
      ) : route.name === 'bench' ? (
        <BenchScreen symbol={symbols[0]?.code ?? '000001'} onBack={() => setRoute({name: 'settings'})} />
      ) : (
        <WatchlistScreen
          userName={userName}
          symbols={symbols}
          error={error}
          onSelect={symbol => {
            track('select_symbol', {symbol: symbol.code});
            setRoute({name: 'quote', symbol});
          }}
          onOpenNotices={() => setRoute({name: 'notices'})}
          onOpenSettings={() => setRoute({name: 'settings'})}
          onOpenAccount={() => setRoute({name: 'account'})}
        />
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
  // 로그아웃 상태에서만: 비대면 계좌 개설 화면, 개설 후 로그인 화면에 채울 아이디
  const [opening, setOpening] = useState(false);
  const [newUsername, setNewUsername] = useState<string | undefined>(undefined);

  useEffect(() => {
    // 시세는 로그인과 무관하게 연결, 로그인하면 세션이 토큰을 넘겨 주문 알림까지 받는다.
    // 백그라운드가 길어지면 끊고 돌아오면 다시 연결(src/market/subscriptions.ts)
    const stopMarket = startMarketLifecycle(
      () => hogaCore.connect(SERVER.ws, SERVER.http),
      () => hogaCore.disconnect(),
    );
    deviceGuard.setSecureScreen(SECURE_SCREEN); // 잔고·주문 화면이 캡처·앱 전환기에 남지 않게
    // 저장된 언어 → 서버 번역 갱신(실패해도 내장 번역으로 계속)
    loadSavedLocale().finally(() => refreshFromServer(SERVER.http));
    session.restore();
    return stopMarket;
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <AppGate>
          {state.status === 'loading' ? (
            <View style={styles.center}>
              <ActivityIndicator />
            </View>
          ) : state.status === 'signedIn' ? (
            <Main userName={state.user.name} />
          ) : opening ? (
            <AccountOpenScreen
              onClose={() => setOpening(false)}
              onOpened={username => {
                setNewUsername(username);
                setOpening(false);
              }}
            />
          ) : (
            <LoginScreen state={state} initialUsername={newUsername} onOpenAccount={() => setOpening(true)} />
          )}
        </AppGate>
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
