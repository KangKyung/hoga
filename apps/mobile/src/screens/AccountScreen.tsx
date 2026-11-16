import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View} from 'react-native';

import {track} from '../analytics/analytics';
import {accountApi, type AccountSummary, type Position} from '../api/account';
import type {SymbolInfo} from '../api/symbols';
import {useI18n} from '../i18n';
import {hogaCore} from '../native/hogaCore';
import {orderService} from '../orders/orderService';
import type {OrderRecord} from '../orders/types';
import {colors, formatPrice, mono} from '../theme';
import {OrderSheet, type AmendTarget} from './OrderSheet';

type Tab = 'balance' | 'open';

/** 화면이 열려 있는 동안 평가금액(현재가)을 다시 읽는 주기 */
const REFRESH_MS = 3_000;

interface Props {
  symbols: SymbolInfo[];
  onBack: () => void;
  onSelectSymbol: (symbol: SymbolInfo) => void;
}

/**
 * 계좌: 잔고(예수금·주문가능금액·보유 종목 평가) / 미체결(정정·취소).
 * 숫자는 서버 원장이 기준. 체결 알림이 오면 바로 다시 읽는다.
 */
export function AccountScreen({symbols, onBack, onSelectSymbol}: Props) {
  const {t} = useI18n();
  const [tab, setTab] = useState<Tab>('balance');
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [open, setOpen] = useState<OrderRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [amending, setAmending] = useState<{record: OrderRecord; target: AmendTarget} | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([accountApi.summary(), orderService.open()]);
      setSummary(s);
      setOpen(o);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    const sub = hogaCore.onOrderEvent(() => load());
    const authed = hogaCore.onAuthenticated(() => load());
    return () => {
      clearInterval(timer);
      sub.remove();
      authed.remove();
    };
  }, [load]);

  const symbolOf = (code: string) => symbols.find(s => s.code === code);

  const cancel = async (record: OrderRecord) => {
    if (busyKey) return;
    setBusyKey(record.key);
    track('cancel_order', {symbol: record.symbol, from: 'account'});
    try {
      await orderService.cancel(record.key);
    } finally {
      setBusyKey(null);
      load();
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable testID="back" onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>{t('quote.back')}</Text>
        </Pressable>
        <Text style={styles.title}>{t('account.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* 불러오는 동안에도 같은 높이를 차지한다: 늦게 채워지며 아래 탭을 밀면 그 사이 누른 탭이 다른 곳에 맞는다 */}
      <View testID="accountSummary" style={[styles.card, styles.summaryCard]}>
        {summary ? (
          <>
            <Text style={styles.accountNo}>{t('account.number', {no: summary.accountNo})}</Text>
            <View style={styles.summaryRow}>
              <SummaryItem label={t('account.equity')} value={summary.totals.equity} strong />
              <SummaryItem
                label={t('account.pnl')}
                value={summary.totals.pnl}
                rate={summary.totals.pnlRate}
                tint={pnlColor(summary.totals.pnl)}
              />
            </View>
            <View style={styles.summaryRow}>
              <SummaryItem label={t('account.cash')} value={summary.cash} />
              <SummaryItem testID="availableCash" label={t('account.available')} value={summary.availableCash} />
            </View>
            <Text style={styles.note}>{t('account.note')}</Text>
          </>
        ) : error ? (
          <Text style={styles.error}>{t('account.error', {error})}</Text>
        ) : (
          <ActivityIndicator style={styles.loading} />
        )}
      </View>

      <View style={styles.tabs}>
        {(['balance', 'open'] as const).map(k => (
          <Pressable key={k} testID={`accountTab-${k}`} onPress={() => setTab(k)} style={[styles.tab, tab === k && styles.tabActive]}>
            <Text style={[styles.tabText, tab === k && styles.tabTextActive]}>
              {k === 'open' ? t('account.tab.open', {n: open.length}) : t('account.tab.balance')}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'balance' ? (
        <FlatList
          data={summary?.positions ?? []}
          keyExtractor={p => p.symbol}
          renderItem={({item}) => (
            <PositionRow
              position={item}
              onPress={() => {
                const s = symbolOf(item.symbol);
                if (s) onSelectSymbol(s);
              }}
            />
          )}
          ItemSeparatorComponent={Separator}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>{t('account.noPositions')}</Text>}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => withRefresh(setRefreshing, load)} />}
        />
      ) : (
        <FlatList
          data={open}
          keyExtractor={o => o.key}
          renderItem={({item}) => (
            <OpenOrderRow
              record={item}
              name={symbolOf(item.symbol)?.name ?? item.symbol}
              busy={busyKey === item.key}
              onAmend={() => {
                track('open_amend', {symbol: item.symbol});
                setAmending({record: item, target: {key: item.key, resting: item.resting}});
              }}
              onCancel={() => cancel(item)}
            />
          )}
          ItemSeparatorComponent={Separator}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>{t('account.noOpen')}</Text>}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => withRefresh(setRefreshing, load)} />}
        />
      )}

      {amending && symbolOf(amending.record.symbol) ? (
        <OrderSheet
          symbol={symbolOf(amending.record.symbol)!}
          initialSide={amending.record.side}
          initialPrice={amending.record.price}
          entry="account"
          amend={amending.target}
          onClose={() => {
            setAmending(null);
            load();
          }}
        />
      ) : null}
    </View>
  );
}

async function withRefresh(set: (v: boolean) => void, fn: () => Promise<void>) {
  set(true);
  try {
    await fn();
  } finally {
    set(false);
  }
}

const pnlColor = (v: number) => (v > 0 ? colors.up : v < 0 ? colors.down : colors.text);
const signed = (v: number) => `${v > 0 ? '+' : ''}${formatPrice(v)}`;

function SummaryItem(props: {label: string; value: number; rate?: number; tint?: string; strong?: boolean; testID?: string}) {
  return (
    <View style={styles.summaryItem}>
      <Text style={styles.summaryLabel}>{props.label}</Text>
      <Text testID={props.testID} style={[styles.summaryValue, mono, props.strong && styles.strong, props.tint ? {color: props.tint} : null]}>
        {props.rate !== undefined ? signed(props.value) : formatPrice(props.value)}
        {props.rate !== undefined ? <Text style={styles.rate}>{` (${props.rate > 0 ? '+' : ''}${props.rate.toFixed(2)}%)`}</Text> : null}
      </Text>
    </View>
  );
}

function PositionRow({position: p, onPress}: {position: Position; onPress: () => void}) {
  const {t} = useI18n();
  const tint = pnlColor(p.pnl);
  return (
    <Pressable testID={`position-${p.symbol}`} onPress={onPress} style={({pressed}) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.flex}>
        <Text style={styles.name}>{p.name}</Text>
        <Text style={styles.sub}>
          {t('account.qty', {qty: formatPrice(p.qty), sellable: formatPrice(p.sellable)})}
        </Text>
        <Text style={styles.sub}>{t('account.avg', {avg: formatPrice(p.avgPrice), last: formatPrice(p.lastPrice)})}</Text>
      </View>
      <View style={styles.right}>
        <Text style={[styles.value, mono]}>{formatPrice(p.value)}</Text>
        <Text style={[styles.pnl, mono, {color: tint}]}>
          {signed(p.pnl)} ({p.pnlRate > 0 ? '+' : ''}
          {p.pnlRate.toFixed(2)}%)
        </Text>
      </View>
    </Pressable>
  );
}

function OpenOrderRow(props: {record: OrderRecord; name: string; busy: boolean; onAmend: () => void; onCancel: () => void}) {
  const {t} = useI18n();
  const r = props.record;
  const tint = r.side === 'bid' ? colors.up : colors.down;
  return (
    <View testID={`open-${r.key}`} style={styles.row}>
      <View style={styles.flex}>
        <Text style={styles.name}>
          {props.name} <Text style={[styles.sideTag, {color: tint}]}>{t(r.side === 'bid' ? 'common.buy' : 'common.sell')}</Text>
        </Text>
        <Text style={[styles.sub, mono]}>
          {t('account.openLine', {price: formatPrice(r.price), resting: formatPrice(r.resting), qty: formatPrice(r.qty)})}
        </Text>
        {r.amendOf ? <Text style={styles.amendNote}>{t('account.amended')}</Text> : null}
      </View>
      <View style={styles.actions}>
        <Pressable testID={`amend-${r.key}`} disabled={props.busy} onPress={props.onAmend} style={styles.actionBtn}>
          <Text style={styles.actionText}>{t('account.amend')}</Text>
        </Pressable>
        <Pressable
          testID={`cancel-${r.key}`}
          disabled={props.busy}
          onPress={props.onCancel}
          style={[styles.actionBtn, props.busy && styles.disabled]}>
          <Text style={[styles.actionText, {color: colors.danger}]}>{t('account.cancel')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const Separator = () => <View style={styles.separator} />;

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10},
  back: {color: colors.accent, fontSize: 16},
  title: {fontSize: 18, fontWeight: '700', color: colors.text},
  headerSpacer: {width: 40},
  card: {marginHorizontal: 16, padding: 14, borderRadius: 12, backgroundColor: colors.card, gap: 10},
  summaryCard: {minHeight: 168, justifyContent: 'center'},
  accountNo: {color: colors.sub, fontSize: 13},
  summaryRow: {flexDirection: 'row', gap: 12},
  summaryItem: {flex: 1},
  summaryLabel: {color: colors.mute, fontSize: 12},
  summaryValue: {color: colors.text, fontSize: 16, fontWeight: '600', marginTop: 2},
  strong: {fontSize: 20, fontWeight: '800'},
  rate: {fontSize: 12},
  note: {color: colors.mute, fontSize: 11},
  error: {color: colors.danger},
  loading: {marginVertical: 20},
  tabs: {flexDirection: 'row', marginHorizontal: 16, marginTop: 14, marginBottom: 8, gap: 8},
  tab: {flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center', backgroundColor: colors.card},
  tabActive: {backgroundColor: colors.accent},
  tabText: {color: colors.sub, fontWeight: '600'},
  tabTextActive: {color: '#fff'},
  list: {marginHorizontal: 16, backgroundColor: colors.card, borderRadius: 10, overflow: 'hidden', paddingBottom: 4},
  row: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 10},
  pressed: {backgroundColor: colors.bg},
  flex: {flex: 1},
  name: {fontSize: 15, fontWeight: '600', color: colors.text},
  sub: {fontSize: 12, color: colors.sub, marginTop: 2},
  right: {alignItems: 'flex-end'},
  value: {fontSize: 15, fontWeight: '700', color: colors.text},
  pnl: {fontSize: 12, marginTop: 2},
  sideTag: {fontSize: 12, fontWeight: '700'},
  amendNote: {fontSize: 11, color: colors.accent, marginTop: 2},
  actions: {flexDirection: 'row', gap: 6},
  actionBtn: {paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: colors.line},
  actionText: {fontSize: 13, fontWeight: '600', color: colors.accent},
  disabled: {opacity: 0.4},
  separator: {height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 14},
  empty: {textAlign: 'center', color: colors.mute, padding: 20},
});
