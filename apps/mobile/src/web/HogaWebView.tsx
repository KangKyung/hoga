import React, {forwardRef, useImperativeHandle, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';
import type {ShouldStartLoadRequest} from 'react-native-webview/lib/WebViewTypes';

import {track, trackFromWeb} from '../analytics/analytics';
import {SERVER} from '../config';
import {getLocale, t} from '../i18n';
import {colors} from '../theme';
import {APP_VERSION} from '../version';
import {BRIDGE_PROTOCOL, isAllowedUrl, parseWebMessage, RateLimiter, toWebScript, type AppToWeb, type WebToApp} from './bridge';

const ALLOWED_ORIGINS = [SERVER.http];

// react-native-webview 14.0.1 타입 정의는 제네릭 기본값이 undefined라 props가 never가 된다 → object로 지정
type WebViewInstance = WebView<object>;

export interface HogaWebViewHandle {
  post(message: AppToWeb): void;
}

interface Props {
  /** 서버 기준 경로(예: /web/stock/?symbol=000001). 허용 출처 밖 주소는 받지 않는다 */
  path: string;
  testID?: string;
  /** hello·track 외의 메시지(openOrder 등)는 화면이 처리한다 */
  onMessage?: (message: Exclude<WebToApp, {type: 'hello' | 'track'}>) => void;
  /** 웹이 hello를 보내 연결이 맺어진 뒤 */
  onReady?: () => void;
}

/**
 * 우리 서버의 웹 화면만 여는 웹뷰.
 * - 허용 출처 밖으로 가는 이동은 막는다(외부 링크는 앱 밖 브라우저로 넘기지도 않는다: 피싱 경로 차단).
 * - 파일 접근·새 창·혼합 콘텐츠 끔, 쿠키·저장소는 이 웹뷰 안에서만.
 */
export const HogaWebView = forwardRef<HogaWebViewHandle, Props>(function HogaWebViewInner({path, testID, onMessage, onReady}, ref) {
  const webview = useRef<WebViewInstance>(null);
  const limiter = useMemo(() => new RateLimiter(20), []);
  const [failed, setFailed] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const post = (message: AppToWeb) => webview.current?.injectJavaScript(toWebScript(message));
  useImperativeHandle(ref, () => ({post}));

  const handleMessage = (event: WebViewMessageEvent) => {
    if (!limiter.take()) {
      track('bridge_rejected', {reason: 'rate', type: 'unknown'});
      return;
    }
    const result = parseWebMessage(event.nativeEvent.data, event.nativeEvent.url, ALLOWED_ORIGINS);
    if (!result.ok) {
      track('bridge_rejected', {reason: result.reason, type: result.type});
      return;
    }
    const {message} = result;
    switch (message.type) {
      case 'hello':
        // 버전 협상: 웹이 더 새 프로토콜이면 앱 업데이트가 필요하다고 알려 준다
        if (message.payload.protocol > BRIDGE_PROTOCOL) {
          post({
            type: 'unsupported',
            payload: {protocol: BRIDGE_PROTOCOL},
          });
          track('bridge_rejected', {reason: 'version', type: 'hello'});
          return;
        }
        post({
          type: 'init',
          payload: {
            protocol: BRIDGE_PROTOCOL,
            locale: getLocale(),
            theme: 'light',
            appVersion: APP_VERSION,
          },
        });
        onReady?.();
        return;
      case 'track':
        if (!trackFromWeb(message.payload.name, message.payload.params)) {
          track('bridge_rejected', {reason: 'schema', type: 'track'});
        }
        return;
      default:
        onMessage?.(message);
    }
  };

  const onShouldStart = (request: ShouldStartLoadRequest) => {
    if (isAllowedUrl(request.url, ALLOWED_ORIGINS)) return true;
    setBlocked(true);
    track('bridge_rejected', {reason: 'origin', type: 'navigation'});
    // 의도적으로 Linking.openURL로 넘기지 않는다: 웹 화면이 임의 외부 주소로 사용자를 보내지 못하게
    return false;
  };

  if (failed) {
    return (
      <View style={styles.center} testID={testID}>
        <Text style={styles.message}>{t('web.failed')}</Text>
        <Pressable
          style={styles.retry}
          onPress={() => {
            setFailed(false);
            setReloadKey(k => k + 1);
          }}>
          <Text style={styles.retryText}>{t('web.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container} testID={testID}>
      <WebView<object>
        key={reloadKey}
        ref={webview}
        source={{uri: `${SERVER.http}${path}`}}
        originWhitelist={ALLOWED_ORIGINS}
        onShouldStartLoadWithRequest={onShouldStart}
        onMessage={handleMessage}
        onError={() => setFailed(true)}
        onHttpError={e => e.nativeEvent.statusCode >= 500 && setFailed(true)}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.accent} />
          </View>
        )}
        javaScriptEnabled
        allowFileAccess={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        mixedContentMode="never"
        allowsBackForwardNavigationGestures
        webviewDebuggingEnabled={__DEV__}
        style={styles.webview}
      />
      {blocked ? (
        <Pressable style={styles.toast} onPress={() => setBlocked(false)}>
          <Text style={styles.toastText}>{t('web.blocked')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  webview: {flex: 1, backgroundColor: colors.bg},
  loading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  message: {color: colors.sub},
  retry: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  retryText: {color: colors.accent, fontWeight: '600'},
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
    backgroundColor: colors.text,
    borderRadius: 10,
    padding: 12,
  },
  toastText: {color: '#fff'},
});
