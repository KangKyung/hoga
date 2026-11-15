import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import type {ConnectionState, SyncState} from '../native/hogaCore';
import {useI18n} from '../i18n';
import {colors} from '../theme';

interface Props {
  connection: ConnectionState;
  sync?: SyncState;
  stale?: boolean;
}

/** 데이터를 믿을 수 있는 상태인지 숨기지 않고 보여 준다. */
export function StatusBadge({connection, sync, stale}: Props) {
  const {t} = useI18n();
  const {key, color} = describe(connection, sync, stale);
  const label = t(key);
  return (
    <View testID="statusBadge" style={[styles.badge, {borderColor: color}]}>
      <View style={[styles.dot, {backgroundColor: color}]} />
      <Text style={[styles.text, {color}]}>{label}</Text>
    </View>
  );
}

function describe(connection: ConnectionState, sync?: SyncState, stale?: boolean) {
  if (connection === 'reconnecting') return {key: 'status.reconnecting', color: colors.danger} as const;
  if (connection !== 'open') return {key: 'status.connecting', color: colors.warn} as const;
  if (sync === 'resyncing') return {key: 'status.resyncing', color: colors.warn} as const;
  if (sync === 'waiting') return {key: 'status.loading', color: colors.warn} as const;
  if (stale) return {key: 'status.stale', color: colors.warn} as const;
  return {key: 'status.live', color: colors.live} as const;
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  dot: {width: 6, height: 6, borderRadius: 3},
  text: {fontSize: 12, fontWeight: '600'},
});
