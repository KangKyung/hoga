import React, {useRef} from 'react';
import {ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, Text, View} from 'react-native';

import {track} from '../analytics/analytics';
import {HttpError, request} from '../api/http';
import {useI18n} from '../i18n';
import {getLocale, t as tr} from '../i18n';
import {documentCapture} from '../native/documentCapture';
import {secureStore} from '../native/security';
import {HogaWebView, type HogaWebViewHandle} from '../web/HogaWebView';
import {colors} from '../theme';

const DRAFT_KEY = 'accountOpen.draft';

interface Draft {
  id: string;
  token: string;
}

async function loadDraft(): Promise<Draft | null> {
  try {
    const raw = await secureStore.get(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

/** 카메라가 있으면 촬영/앨범을 고르게 하고, 없으면(시뮬레이터 등) 바로 앨범 */
function chooseSource(): Promise<'camera' | 'library' | null> {
  if (!documentCapture.isCameraAvailable()) return Promise.resolve('library');
  return new Promise(resolve => {
    const options = [tr('accountOpen.camera'), tr('accountOpen.library'), tr('common.cancel')];
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({options, cancelButtonIndex: 2}, i =>
        resolve(i === 0 ? 'camera' : i === 1 ? 'library' : null),
      );
    } else {
      Alert.alert(tr('accountOpen.idCardTitle'), undefined, [
        {text: options[0], onPress: () => resolve('camera')},
        {text: options[1], onPress: () => resolve('library')},
        {text: options[2], style: 'cancel', onPress: () => resolve(null)},
      ]);
    }
  });
}

interface Props {
  onClose: () => void;
  /** 개설 완료: 로그인 화면에 새 아이디를 채운다 */
  onOpened: (username: string) => void;
}

/**
 * 비대면 계좌 개설. 단계 화면은 서버 웹(HTML/JS)이라 앱 배포 없이 약관·문구·단계를 바꿀 수 있다.
 * 앱은 웹이 못 하는 일만 한다: 신청서 토큰 보관(보안 저장소), 신분증 촬영·업로드(네이티브).
 * 신분증 이미지는 웹뷰·브리지를 지나지 않고 앱이 바로 서버로 올린다.
 */
export function AccountOpenScreen({onClose, onOpened}: Props) {
  const {t} = useI18n();
  const web = useRef<HogaWebViewHandle>(null);
  const draft = useRef<Draft | null>(null);

  const captureAndUpload = async () => {
    const current = draft.current;
    if (!current) return web.current?.post({type: 'idCardResult', payload: {ok: false, error: 'NO_APPLICATION'}});
    try {
      const source = await chooseSource();
      if (!source) return web.current?.post({type: 'idCardResult', payload: {ok: false, error: 'CANCELLED'}});
      const image = await documentCapture.capture(source);
      if (!image) return web.current?.post({type: 'idCardResult', payload: {ok: false, error: 'CANCELLED'}});
      track('account_open_id_card', {source, bytes: image.bytes});
      await request(`/account-open/${current.id}/id-card`, {
        method: 'POST',
        headers: {'x-application-token': current.token},
        body: {image: image.base64},
        timeoutMs: 20_000,
      });
      web.current?.post({type: 'idCardResult', payload: {ok: true, bytes: image.bytes}});
    } catch (e) {
      const error = e instanceof HttpError ? e.body.error ?? `HTTP_${e.status}` : (e as {code?: string}).code ?? 'FAILED';
      web.current?.post({type: 'idCardResult', payload: {ok: false, error: String(error)}});
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable testID="closeAccountOpen" onPress={onClose} hitSlop={12}>
          <Text style={styles.back}>{t('common.close')}</Text>
        </Pressable>
        <Text style={styles.title}>{t('accountOpen.title')}</Text>
        <View style={styles.spacer} />
      </View>
      <HogaWebView
        ref={web}
        testID="accountOpenWeb"
        path={`/web/account-open/?lang=${getLocale()}`}
        onReady={async () => {
          draft.current = await loadDraft();
          web.current?.post({type: 'draft', payload: {id: draft.current?.id ?? null, token: draft.current?.token ?? null}});
        }}
        onMessage={async m => {
          switch (m.type) {
            case 'saveDraft':
              draft.current = m.payload;
              await secureStore.set(DRAFT_KEY, JSON.stringify(m.payload));
              return;
            case 'clearDraft':
              draft.current = null;
              await secureStore.remove(DRAFT_KEY).catch(() => {});
              return;
            case 'captureIdCard':
              await captureAndUpload();
              return;
            case 'accountOpened':
              draft.current = null;
              await secureStore.remove(DRAFT_KEY).catch(() => {});
              track('account_open_complete', {});
              onOpened(m.payload.username);
              return;
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10},
  back: {color: colors.accent, fontSize: 16},
  title: {fontSize: 17, fontWeight: '700', color: colors.text},
  spacer: {width: 40},
});
