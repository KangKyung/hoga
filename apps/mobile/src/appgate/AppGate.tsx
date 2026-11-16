import React, {useState} from 'react';
import {Linking, Pressable, StyleSheet, Text, View} from 'react-native';

import {track} from '../analytics/analytics';
import {useI18n} from '../i18n';
import {colors} from '../theme';
import {APP_VERSION} from '../version';
import {useAppConfig} from './appConfig';

/**
 * 앱 전체를 감싸는 문지기.
 * - 강제 업데이트(현재 버전 < 최소 버전): 업데이트 화면만. 옛 버전이 바뀐 프로토콜·보안 수정 없이 주문하지 않게.
 * - 점검: 점검 화면(종료 예정 시각·다시 확인). 서버도 주문·로그인을 503으로 막는다.
 * - 업데이트 안내(최신보다 낮음): 닫을 수 있는 띠. 같은 버전 안내는 한 번 닫으면 다시 띄우지 않는다.
 */
export function AppGate({children}: {children: React.ReactNode}) {
  const {t} = useI18n();
  const {config, reload} = useAppConfig();
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (config.update === 'required') {
    return (
      <View testID="forceUpdate" style={styles.full}>
        <Text style={styles.title}>{t('gate.updateTitle')}</Text>
        <Text style={styles.body}>{t('gate.updateBody', {current: APP_VERSION, min: config.minVersion})}</Text>
        <Pressable
          testID="openStore"
          style={styles.primary}
          onPress={() => {
            track('open_store', {reason: 'required'});
            if (config.storeUrl) Linking.openURL(config.storeUrl).catch(() => {});
          }}>
          <Text style={styles.primaryText}>{t('gate.updateAction')}</Text>
        </Pressable>
      </View>
    );
  }

  if (config.maintenance.active) {
    const until = config.maintenance.until ? new Date(config.maintenance.until) : null;
    return (
      <View testID="maintenance" style={styles.full}>
        <Text style={styles.title}>{t('gate.maintenanceTitle')}</Text>
        <Text style={styles.body}>{config.maintenance.message}</Text>
        {until ? (
          <Text style={styles.until}>
            {t('gate.maintenanceUntil', {
              time: `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`,
            })}
          </Text>
        ) : null}
        <Pressable testID="retryGate" style={styles.secondary} onPress={reload}>
          <Text style={styles.secondaryText}>{t('gate.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      {children}
      {config.update === 'optional' && dismissed !== config.latestVersion ? (
        <View testID="updateBanner" style={styles.banner}>
          <Text style={styles.bannerText}>{t('gate.updateAvailable', {version: config.latestVersion})}</Text>
          <Pressable
            hitSlop={8}
            onPress={() => {
              track('open_store', {reason: 'optional'});
              if (config.storeUrl) Linking.openURL(config.storeUrl).catch(() => {});
            }}>
            <Text style={styles.bannerAction}>{t('gate.updateAction')}</Text>
          </Pressable>
          <Pressable testID="dismissUpdate" hitSlop={8} onPress={() => setDismissed(config.latestVersion)}>
            <Text style={styles.bannerClose}>✕</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {flex: 1},
  full: {flex: 1, justifyContent: 'center', padding: 28, gap: 14, backgroundColor: colors.bg},
  title: {fontSize: 24, fontWeight: '800', color: colors.accent},
  body: {fontSize: 15, color: colors.text, lineHeight: 22},
  until: {fontSize: 14, color: colors.sub},
  primary: {backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 8},
  primaryText: {color: '#fff', fontWeight: '700', fontSize: 16},
  secondary: {borderRadius: 10, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.line},
  secondaryText: {color: colors.accent, fontWeight: '600', fontSize: 15},
  banner: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bannerText: {flex: 1, color: colors.text, fontSize: 13},
  bannerAction: {color: colors.accent, fontWeight: '700'},
  bannerClose: {color: colors.mute, fontSize: 16},
});
