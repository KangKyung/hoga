import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {useI18n} from '../i18n';
import {colors} from '../theme';
import {HogaWebView} from '../web/HogaWebView';

/** 공지사항: 서버의 AngularJS 웹 화면(/web/notices/)을 연다. 앱을 다시 배포하지 않고 내용·화면을 바꿀 수 있다 */
export function NoticesScreen({onBack}: {onBack: () => void}) {
  const {t, locale} = useI18n();
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable testID="back" onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>{t('quote.back')}</Text>
        </Pressable>
      </View>
      <HogaWebView testID="noticesWeb" path={`/web/notices/?lang=${locale}`} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  header: {paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4},
  back: {fontSize: 16, color: colors.accent, fontWeight: '600'},
});
