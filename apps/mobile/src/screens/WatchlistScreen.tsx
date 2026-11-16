import React, {useCallback, useMemo, useRef, useState} from 'react';
import {FlatList, Pressable, StyleSheet, Text, TextInput, View, type ListViewToken} from 'react-native';

import type {SymbolInfo} from '../api/symbols';
import {session} from '../auth/session';
import {StatusBadge} from '../components/StatusBadge';
import {deviceGuard} from '../native/security';
import {useBook, useConnectionState, useTrades} from '../hooks/market';
import {useI18n} from '../i18n';
import {useActiveCount, useSubscription} from '../market/subscriptions';
import {colors, formatChange, formatPrice, mono, priceColor} from '../theme';

interface Props {
  userName: string;
  symbols: SymbolInfo[];
  error: string | null;
  onSelect: (symbol: SymbolInfo) => void;
  onOpenNotices: () => void;
  onOpenSettings: () => void;
  onOpenAccount: () => void;
}

/** 화면 밖 위아래로 몇 줄 더 미리 구독할지(빠르게 스크롤해도 빈 값이 덜 보이게) */
const PREFETCH_ROWS = 2;

export function WatchlistScreen({userName, symbols, error, onSelect, onOpenNotices, onOpenSettings, onOpenAccount}: Props) {
  const {t} = useI18n();
  const connection = useConnectionState();
  const security = deviceGuard.status();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? symbols.filter(s => s.code.includes(q) || s.name.toLowerCase().includes(q)) : symbols;
  }, [symbols, query]);

  // 화면에 보이는 줄(+앞뒤 몇 줄)만 구독한다. 나머지는 마지막으로 받은 가격을 흐리게 보여 준다
  const [visible, setVisible] = useState<string[]>([]);
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const onViewableItemsChanged = useCallback(({viewableItems}: {viewableItems: ListViewToken[]}) => {
    const idx = viewableItems.map(v => v.index ?? 0);
    if (!idx.length) return setVisible([]);
    const list = filteredRef.current;
    const from = Math.max(0, Math.min(...idx) - PREFETCH_ROWS);
    const to = Math.min(list.length, Math.max(...idx) + 1 + PREFETCH_ROWS);
    setVisible(list.slice(from, to).map(s => s.code));
  }, []);
  const viewabilityConfig = useRef({itemVisiblePercentThreshold: 10, minimumViewTime: 80}).current;
  useSubscription(visible);
  const live = useActiveCount();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('watchlist.title')}</Text>
        <StatusBadge connection={connection} sync="live" />
      </View>
      <View style={styles.userRow}>
        <Text style={styles.user}>{t('watchlist.user', {name: userName})}</Text>
        <View style={styles.links}>
          <Pressable testID="openAccount" onPress={onOpenAccount} hitSlop={8}>
            <Text style={styles.logout}>{t('watchlist.account')}</Text>
          </Pressable>
          <Pressable testID="openNotices" onPress={onOpenNotices} hitSlop={8}>
            <Text style={styles.logout}>{t('watchlist.notices')}</Text>
          </Pressable>
          <Pressable testID="openSettings" onPress={onOpenSettings} hitSlop={8}>
            <Text style={styles.logout}>{t('watchlist.settings')}</Text>
          </Pressable>
          <Pressable testID="logout" onPress={() => session.logout()} hitSlop={8}>
            <Text style={styles.logout}>{t('watchlist.logout')}</Text>
          </Pressable>
        </View>
      </View>
      {error ? <Text style={styles.error}>{t('watchlist.unreachable', {error})}</Text> : null}
      <View style={styles.searchRow}>
        <TextInput
          testID="symbolSearch"
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder={t('watchlist.search')}
          placeholderTextColor={colors.mute}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
        <Text testID="liveCount" style={styles.liveCount}>
          {t('watchlist.liveCount', {live, total: symbols.length})}
        </Text>
      </View>
      <FlatList
        testID="watchList"
        data={filtered}
        keyExtractor={s => s.code}
        renderItem={({item}) => <WatchRow symbol={item} onPress={() => onSelect(item)} />}
        ItemSeparatorComponent={Separator}
        style={styles.listBox}
        contentContainerStyle={styles.list}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={15}
        windowSize={5}
      />
      <Text testID="securitySignal" style={[styles.footnote, security.compromised && styles.warning]}>
        {security.compromised
          ? t('watchlist.securityWarning', {
              reasons: security.reasons.join(', '),
            })
          : security.emulator
          ? t('watchlist.securityEmulator')
          : t('watchlist.securityOk')}
      </Text>
      <Text style={styles.footnote}>{t('watchlist.footnote')}</Text>
    </View>
  );
}

const Separator = () => <View style={styles.separator} />;

function WatchRow({symbol, onPress}: {symbol: SymbolInfo; onPress: () => void}) {
  const book = useBook(symbol.code, 1);
  const [lastTrade] = useTrades(symbol.code, 1);
  const bestBid = book.bids[0]?.[0];
  const bestAsk = book.asks[0]?.[0];
  const price = lastTrade?.price ?? (bestBid && bestAsk ? Math.round((bestBid + bestAsk) / 2) : symbol.lastPrice);
  const color = priceColor(price, symbol.basePrice);
  const {t} = useI18n();
  const status = book.session;

  return (
    <Pressable testID={`watch-${symbol.code}`} onPress={onPress} style={({pressed}) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.nameCol}>
        <Text style={styles.name}>{symbol.name}</Text>
        <Text style={styles.code}>
          {symbol.code}
          {status.viKind ? <Text style={styles.viTag}>{`  ${t('session.viShort')}`}</Text> : null}
        </Text>
      </View>
      <View style={[styles.priceCol, !book.subscribed && styles.notLive]}>
        <Text style={[styles.price, mono, {color}]}>{formatPrice(price)}</Text>
        <Text style={[styles.change, mono, {color}]}>{formatChange(price, symbol.basePrice)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  title: {fontSize: 24, fontWeight: '700', color: colors.accent},
  error: {marginHorizontal: 16, marginBottom: 8, color: colors.danger},
  listBox: {flex: 1},
  list: {
    marginHorizontal: 16,
    backgroundColor: colors.card,
    borderRadius: 10,
    overflow: 'hidden',
  },
  searchRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 8},
  search: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    color: colors.text,
  },
  liveCount: {color: colors.mute, fontSize: 12},
  notLive: {opacity: 0.45},
  viTag: {color: colors.danger, fontWeight: '700'},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  pressed: {backgroundColor: colors.bg},
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.line,
    marginLeft: 14,
  },
  nameCol: {flex: 1},
  name: {fontSize: 16, fontWeight: '600', color: colors.text},
  code: {fontSize: 12, color: colors.mute, marginTop: 2},
  priceCol: {alignItems: 'flex-end'},
  price: {fontSize: 17, fontWeight: '700'},
  change: {fontSize: 12, marginTop: 2},
  footnote: {
    textAlign: 'center',
    color: colors.mute,
    fontSize: 11,
    marginTop: 8,
    marginBottom: 4,
  },
  warning: {color: colors.danger},
  userRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  user: {color: colors.sub},
  logout: {color: colors.accent},
  links: {flexDirection: 'row', gap: 16},
});
