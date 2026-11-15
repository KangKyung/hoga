import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import type {ConnectionState, SyncState} from '../native/hogaCore';
import {colors} from '../theme';

interface Props {
  connection: ConnectionState;
  sync?: SyncState;
  stale?: boolean;
}

/** 데이터를 믿을 수 있는 상태인지 숨기지 않고 보여 준다. */
export function StatusBadge({connection, sync, stale}: Props) {
  const {label, color} = describe(connection, sync, stale);
  return (
    <View testID="statusBadge" style={[styles.badge, {borderColor: color}]}>
      <View style={[styles.dot, {backgroundColor: color}]} />
      <Text style={[styles.text, {color}]}>{label}</Text>
    </View>
  );
}

function describe(connection: ConnectionState, sync?: SyncState, stale?: boolean) {
  if (connection === 'reconnecting') return {label: '재연결 중', color: colors.danger};
  if (connection !== 'open') return {label: '연결 중', color: colors.warn};
  if (sync === 'resyncing') return {label: '동기화 중', color: colors.warn};
  if (sync === 'waiting') return {label: '불러오는 중', color: colors.warn};
  if (stale) return {label: '지연', color: colors.warn};
  return {label: '실시간', color: colors.live};
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
