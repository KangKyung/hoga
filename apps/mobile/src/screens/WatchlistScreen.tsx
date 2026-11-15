import React from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';

import type {SymbolInfo} from '../api/symbols';
import {StatusBadge} from '../components/StatusBadge';
import {useBook, useConnectionState, useTrades} from '../hooks/market';
import {colors, formatChange, formatPrice, mono, priceColor} from '../theme';

interface Props {
  symbols: SymbolInfo[];
  error: string | null;
  onSelect: (symbol: SymbolInfo) => void;
}

export function WatchlistScreen({symbols, error, onSelect}: Props) {
  const connection = useConnectionState();
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>관심종목</Text>
        <StatusBadge connection={connection} sync="live" />
      </View>
      {error ? <Text style={styles.error}>서버에 연결할 수 없습니다 · {error}</Text> : null}
      <FlatList
        data={symbols}
        keyExtractor={s => s.code}
        renderItem={({item}) => <WatchRow symbol={item} onPress={() => onSelect(item)} />}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={styles.list}
      />
      <Text style={styles.footnote}>모의 데이터 · 실제 종목과 무관합니다</Text>
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

  return (
    <Pressable testID={`watch-${symbol.code}`} onPress={onPress} style={({pressed}) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.nameCol}>
        <Text style={styles.name}>{symbol.name}</Text>
        <Text style={styles.code}>{symbol.code}</Text>
      </View>
      <View style={styles.priceCol}>
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
  list: {marginHorizontal: 16, backgroundColor: colors.card, borderRadius: 10, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12},
  pressed: {backgroundColor: colors.bg},
  separator: {height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 14},
  nameCol: {flex: 1},
  name: {fontSize: 16, fontWeight: '600', color: colors.text},
  code: {fontSize: 12, color: colors.mute, marginTop: 2},
  priceCol: {alignItems: 'flex-end'},
  price: {fontSize: 17, fontWeight: '700'},
  change: {fontSize: 12, marginTop: 2},
  footnote: {textAlign: 'center', color: colors.mute, fontSize: 11, marginVertical: 12},
});
