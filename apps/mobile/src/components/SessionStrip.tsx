import React, {useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {useI18n} from '../i18n';
import type {SessionView} from '../native/hogaCore';
import {colors, formatPrice, mono} from '../theme';

/**
 * 호가 화면 위의 매매 상태 띠: 장 구간, VI(남은 시간), 단일가 예상 체결가·수량.
 * 단일가(동시호가·VI) 중에는 호가가 겹쳐 보일 수 있어 "예상 체결"을 함께 보여 준다.
 */
export function SessionStrip({session}: {session: SessionView}) {
  const {t} = useI18n();
  const left = useSecondsLeft(session.viUntil);
  if (!session.phase) return null;
  const auction = session.mode === 'AUCTION';
  return (
    <View testID="sessionStrip" style={styles.row}>
      <Text testID="sessionPhase" style={[styles.badge, session.phase === 'OPEN' ? styles.open : styles.closed]}>
        {t(`session.phase.${session.phase}`)}
      </Text>
      {session.viKind ? (
        <Text testID="viBadge" style={[styles.badge, styles.vi]}>
          {t('session.vi', {kind: t(`session.vi.${session.viKind}`), sec: left})}
        </Text>
      ) : null}
      {auction ? (
        <Text testID="expected" style={[styles.exp, mono]}>
          {session.expQty > 0
            ? t('session.expected', {price: formatPrice(session.expPrice), qty: formatPrice(session.expQty)})
            : t('session.noExpected')}
        </Text>
      ) : null}
    </View>
  );
}

function useSecondsLeft(until: number): number {
  // 매 렌더마다 지금 시각으로 계산하고, 1초마다 다시 그리기만 한다(값이 바뀐 첫 렌더에 0이 잠깐 보이지 않게)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0;
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 8},
  badge: {fontSize: 12, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden'},
  open: {backgroundColor: '#e7f5ec', color: '#1d7a46'},
  closed: {backgroundColor: '#eef0f3', color: colors.sub},
  vi: {backgroundColor: '#fde8e8', color: colors.danger},
  exp: {fontSize: 12, color: colors.text},
});
