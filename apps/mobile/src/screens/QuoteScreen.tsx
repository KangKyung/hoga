import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import type {SymbolInfo} from '../api/symbols';
import {MyOrders} from '../components/MyOrders';
import {StatusBadge} from '../components/StatusBadge';
import {useBook, useConnectionState, useStats, useTrades} from '../hooks/market';
import type {Level, Trade} from '../native/hogaCore';
import type {Side} from '../orders/types';
import {colors, formatChange, formatPrice, mono, priceColor} from '../theme';
import {OrderSheet} from './OrderSheet';

const DEPTH = 10;

interface Props {
  symbol: SymbolInfo;
  onBack: () => void;
}

export function QuoteScreen({symbol, onBack}: Props) {
  const connection = useConnectionState();
  const book = useBook(symbol.code, DEPTH);
  const trades = useTrades(symbol.code, 12);
  const stats = useStats();

  const lastPrice = trades[0]?.price ?? symbol.lastPrice;
  const [order, setOrder] = useState<{side: Side; price: number} | null>(null);
  // 호가를 누르면 그 가격으로 주문: 매도 호가 → 매수, 매수 호가 → 매도
  const openOrder = (side: Side, price: number) => setOrder({side, price});
  const priceTint = priceColor(lastPrice, symbol.basePrice);

  // 직전 화면과 잔량이 달라진 가격대만 잠깐 강조한다.
  const prev = useRef(new Map<number, number>());
  const changed = useMemo(() => {
    const set = new Set<number>();
    for (const [px, qty] of [...book.bids, ...book.asks]) {
      if (prev.current.size > 0 && prev.current.get(px) !== qty) set.add(px);
    }
    return set;
  }, [book]);
  useEffect(() => {
    prev.current = new Map([...book.bids, ...book.asks]);
  }, [book]);

  const maxQty = Math.max(1, ...book.bids.map(l => l[1]), ...book.asks.map(l => l[1]));
  // 매도는 높은 가격이 위, 최우선 매도가 가운데에 오도록 뒤집는다.
  const asksTopDown = [...book.asks].reverse();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable testID="back" onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ 목록</Text>
        </Pressable>
        <StatusBadge connection={connection} sync={book.sync} stale={book.stale} />
      </View>

      <View style={styles.summary}>
        <Text style={styles.name}>
          {symbol.name} <Text style={styles.code}>{symbol.code}</Text>
        </Text>
        <Text testID="lastPrice" style={[styles.last, mono, {color: priceTint}]}>
          {formatPrice(lastPrice)}
        </Text>
        <Text style={[styles.change, mono, {color: priceTint}]}>{formatChange(lastPrice, symbol.basePrice)}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.card}>
          <View style={styles.bookHeader}>
            <Text style={[styles.bookHeaderText, {color: colors.down}]}>매도잔량</Text>
            <Text style={styles.bookHeaderText}>호가</Text>
            <Text style={[styles.bookHeaderText, {color: colors.up}]}>매수잔량</Text>
          </View>
          {asksTopDown.map(level => (
            <BookRow
              key={`a${level[0]}`}
              side="ask"
              level={level}
              maxQty={maxQty}
              base={symbol.basePrice}
              flash={changed.has(level[0])}
              current={level[0] === lastPrice}
              onPress={() => openOrder('bid', level[0])}
            />
          ))}
          <View style={styles.mid} />
          {book.bids.map(level => (
            <BookRow
              key={`b${level[0]}`}
              side="bid"
              level={level}
              maxQty={maxQty}
              base={symbol.basePrice}
              flash={changed.has(level[0])}
              current={level[0] === lastPrice}
              onPress={() => openOrder('ask', level[0])}
            />
          ))}
          {book.bids.length + book.asks.length === 0 ? (
            <Text style={styles.empty}>호가를 불러오는 중…</Text>
          ) : null}
        </View>

        <MyOrders symbol={symbol.code} />

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>체결</Text>
          {trades.map((t, i) => (
            <TradeRow key={`${t.ts}-${i}`} trade={t} />
          ))}
          {trades.length === 0 ? <Text style={styles.empty}>체결 대기 중</Text> : null}
        </View>

        <Text testID="stats" style={styles.stats}>
          seq {book.seq} · 누락 감지 {stats.gaps} · 재동기화 {stats.resyncs} · 재연결 {stats.reconnects}
        </Text>
      </ScrollView>

      <View style={styles.actions}>
        <Pressable
          testID="sellButton"
          style={[styles.action, {backgroundColor: colors.down}]}
          onPress={() => openOrder('ask', book.bids[0]?.[0] ?? lastPrice)}>
          <Text style={styles.actionText}>매도</Text>
        </Pressable>
        <Pressable
          testID="buyButton"
          style={[styles.action, {backgroundColor: colors.up}]}
          onPress={() => openOrder('bid', book.asks[0]?.[0] ?? lastPrice)}>
          <Text style={styles.actionText}>매수</Text>
        </Pressable>
      </View>

      {order ? (
        <OrderSheet symbol={symbol} initialSide={order.side} initialPrice={order.price} onClose={() => setOrder(null)} />
      ) : null}
    </View>
  );
}

function BookRow(props: {
  side: 'bid' | 'ask';
  level: Level;
  maxQty: number;
  base: number;
  flash: boolean;
  current: boolean;
  onPress: () => void;
}) {
  const {side, level, maxQty, base, flash, current, onPress} = props;
  const [price, qty] = level;
  const width = `${Math.max(2, (qty / maxQty) * 100)}%` as const;
  const isAsk = side === 'ask';
  return (
    <Pressable
      testID={`${side}-${price}`}
      onPress={onPress}
      style={[styles.row, {backgroundColor: isAsk ? colors.downSoft : colors.upSoft}, flash && styles.flash]}>
      <View style={styles.qtyCell}>
        {isAsk ? (
          <>
            <View style={[styles.bar, styles.barRight, {width, backgroundColor: colors.downSoft}]} />
            <Text style={[styles.qty, mono]}>{formatPrice(qty)}</Text>
          </>
        ) : null}
      </View>
      <View style={[styles.priceCell, current && styles.current]}>
        <Text style={[styles.price, mono, {color: priceColor(price, base)}]}>{formatPrice(price)}</Text>
      </View>
      <View style={styles.qtyCell}>
        {!isAsk ? (
          <>
            <View style={[styles.bar, styles.barLeft, {width, backgroundColor: colors.upSoft}]} />
            <Text style={[styles.qty, styles.qtyLeft, mono]}>{formatPrice(qty)}</Text>
          </>
        ) : null}
      </View>
    </Pressable>
  );
}

function TradeRow({trade}: {trade: Trade}) {
  const time = new Date(trade.ts).toTimeString().slice(0, 8);
  const color = trade.aggressor === 'bid' ? colors.up : colors.down;
  return (
    <View style={styles.tradeRow}>
      <Text style={[styles.tradeText, mono, {color: colors.mute}]}>{time}</Text>
      <Text style={[styles.tradeText, mono]}>{formatPrice(trade.price)}</Text>
      <Text style={[styles.tradeText, styles.tradeQty, mono, {color}]}>{formatPrice(trade.qty)}</Text>
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
  summary: {paddingHorizontal: 16, paddingBottom: 10},
  name: {fontSize: 18, fontWeight: '700', color: colors.text},
  code: {fontSize: 13, fontWeight: '400', color: colors.mute},
  last: {fontSize: 28, fontWeight: '800', marginTop: 2},
  change: {fontSize: 13},
  scroll: {paddingHorizontal: 16, paddingBottom: 24, gap: 12},
  card: {backgroundColor: colors.card, borderRadius: 10, overflow: 'hidden', paddingVertical: 4},
  bookHeader: {flexDirection: 'row', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line},
  bookHeaderText: {flex: 1, textAlign: 'center', fontSize: 12, color: colors.mute},
  row: {flexDirection: 'row', height: 30, alignItems: 'center', marginVertical: 0.5},
  flash: {opacity: 0.7},
  qtyCell: {flex: 1, height: '100%', justifyContent: 'center'},
  bar: {position: 'absolute', top: 3, bottom: 3},
  barRight: {right: 0},
  barLeft: {left: 0},
  qty: {textAlign: 'right', paddingHorizontal: 8, fontSize: 13, color: colors.text},
  qtyLeft: {textAlign: 'left'},
  priceCell: {flex: 1, height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card},
  current: {borderWidth: 1.5, borderColor: colors.text},
  price: {fontSize: 14, fontWeight: '700'},
  mid: {height: 1, backgroundColor: colors.line, marginVertical: 2},
  empty: {textAlign: 'center', color: colors.mute, paddingVertical: 16},
  sectionTitle: {fontSize: 13, fontWeight: '700', color: colors.sub, paddingHorizontal: 12, paddingVertical: 6},
  tradeRow: {flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 3},
  tradeText: {flex: 1, fontSize: 13, color: colors.text},
  tradeQty: {textAlign: 'right'},
  stats: {textAlign: 'center', fontSize: 11, color: colors.mute},
  actions: {flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, backgroundColor: colors.bg},
  action: {flex: 1, borderRadius: 10, paddingVertical: 14, alignItems: 'center'},
  actionText: {color: '#fff', fontSize: 16, fontWeight: '700'},
});
