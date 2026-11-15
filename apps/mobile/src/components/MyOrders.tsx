import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {orderService} from '../orders/orderService';
import {useMyOrders} from '../orders/useMyOrders';
import type {OrderRecord} from '../orders/types';
import {useI18n} from '../i18n';
import {colors, formatPrice, mono} from '../theme';

const statusKey = (status: OrderRecord['status']) => `orderStatus.${status}` as const;

export function MyOrders({symbol}: {symbol: string}) {
  const {t} = useI18n();
  const {orders, reload} = useMyOrders(symbol);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const cancel = async (key: string) => {
    if (cancelling) return;
    setCancelling(key);
    try {
      await orderService.cancel(key);
    } finally {
      setCancelling(null);
      reload();
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t('orders.title')}</Text>
      {orders.length === 0 ? <Text style={styles.empty}>{t('orders.empty')}</Text> : null}
      {orders.slice(0, 10).map(o => (
        <View key={o.key} testID={`myOrder-${o.key}`} style={styles.row}>
          <Text style={[styles.side, {color: o.side === 'bid' ? colors.up : colors.down}]}>
            {t(o.side === 'bid' ? 'common.buy' : 'common.sell')}
          </Text>
          <View style={styles.info}>
            <Text style={[styles.main, mono]}>
              {o.type === 'market' ? t('common.market') : formatPrice(o.price)} · {t('common.shares', {n: formatPrice(o.qty)})}
            </Text>
            <Text style={[styles.sub, mono]}>
              {t(statusKey(o.status))}
              {o.filled > 0 && o.status !== 'FILLED'
                ? t('orders.partialFilled', {
                    filled: formatPrice(o.filled),
                    qty: formatPrice(o.qty),
                  })
                : ''}
            </Text>
          </View>
          {o.resting > 0 && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED') ? (
            <Pressable testID={`cancel-${o.key}`} style={styles.cancel} disabled={!!cancelling} onPress={() => cancel(o.key)}>
              <Text style={styles.cancelText}>{cancelling === o.key ? '…' : t('common.cancel')}</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {backgroundColor: colors.card, borderRadius: 10, paddingVertical: 4},
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.sub,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  empty: {textAlign: 'center', color: colors.mute, paddingVertical: 12},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 10,
  },
  side: {fontWeight: '700', width: 32},
  info: {flex: 1},
  main: {fontSize: 14, color: colors.text},
  sub: {fontSize: 12, color: colors.mute, marginTop: 2},
  cancel: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  cancelText: {color: colors.sub, fontWeight: '600'},
});
