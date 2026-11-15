import React, {useSyncExternalStore} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import {debugSink, track} from '../analytics/analytics';
import {SERVER} from '../config';
import {LOCALE_NAMES, LOCALES, refreshFromServer, setLocale, useI18n, type Locale} from '../i18n';
import {saveLocale} from '../i18n/persist';
import {colors, mono} from '../theme';

const APP_VERSION = '0.5.0';
const SAMPLE = 1234567.89;

export function SettingsScreen({onBack}: {onBack: () => void}) {
  const {t, locale, remoteVersion} = useI18n();
  const events = useSyncExternalStore(debugSink.subscribe, debugSink.recent);

  const choose = (next: Locale) => {
    if (next === locale) return;
    track('change_language', {from: locale, to: next});
    setLocale(next);
    saveLocale(next);
    refreshFromServer(SERVER.http);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable testID="back" onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>{t('quote.back')}</Text>
        </Pressable>
        <Text style={styles.title}>{t('settings.title')}</Text>
        <View style={styles.spacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.card}>
          <Text style={styles.section}>{t('settings.language')}</Text>
          {LOCALES.map(l => (
            <Pressable
              key={l}
              testID={`locale-${l}`}
              accessibilityRole="radio"
              accessibilityState={{selected: l === locale}}
              onPress={() => choose(l)}
              style={({pressed}) => [styles.row, pressed && styles.pressed]}>
              <View style={[styles.radio, l === locale && styles.radioOn]} />
              <Text style={styles.rowText}>{LOCALE_NAMES[l]}</Text>
              <Text style={[styles.sample, mono]}>{new Intl.NumberFormat(l).format(SAMPLE)}</Text>
            </Pressable>
          ))}
          <Text style={styles.hint}>{t('settings.languageHint')}</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.kv}>
            <Text style={styles.key}>{t('settings.translations')}</Text>
            <Text testID="translationVersion" style={[styles.value, mono]}>
              {remoteVersion ? t('settings.translationsRemote', {version: remoteVersion}) : t('settings.translationsBundled')}
            </Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.key}>{t('settings.version', {version: APP_VERSION})}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.section}>{t('settings.analytics', {n: events.length})}</Text>
          {events.length === 0 ? <Text style={styles.hint}>{t('settings.analyticsEmpty')}</Text> : null}
          {events.map((e, i) => (
            <View key={`${e.ts}-${i}`} style={styles.event}>
              <Text style={[styles.eventName, mono]}>
                {e.source === 'web' ? '🌐 ' : ''}
                {e.name}
              </Text>
              <Text style={[styles.eventParams, mono]} numberOfLines={2}>
                {Object.entries(e.params)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' ')}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
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
  title: {fontSize: 17, fontWeight: '700', color: colors.text},
  spacer: {width: 48},
  scroll: {paddingHorizontal: 16, paddingBottom: 32, gap: 12},
  card: {backgroundColor: colors.card, borderRadius: 10, paddingVertical: 6},
  section: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.sub,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  pressed: {backgroundColor: colors.bg},
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.line,
  },
  radioOn: {borderColor: colors.accent, borderWidth: 6},
  rowText: {flex: 1, fontSize: 16, color: colors.text},
  sample: {fontSize: 13, color: colors.mute},
  hint: {
    fontSize: 12,
    color: colors.mute,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  kv: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 12,
  },
  key: {color: colors.sub},
  value: {color: colors.text},
  event: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  eventName: {fontSize: 13, fontWeight: '600', color: colors.text},
  eventParams: {fontSize: 11, color: colors.mute, marginTop: 2},
});
