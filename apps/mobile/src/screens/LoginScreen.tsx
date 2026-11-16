import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View} from 'react-native';

import {session, type SessionState} from '../auth/session';
import {secureStore, type BiometryType} from '../native/security';
import {useI18n} from '../i18n';
import {colors} from '../theme';

/** 제품명(Face ID 등)은 번역하지 않는다 */
const BIOMETRY_LABEL: Record<BiometryType, string> = {
  faceId: 'Face ID',
  touchId: 'Touch ID',
  opticId: 'Optic ID',
  biometric: '',
  none: '',
};

interface Props {
  state: Extract<SessionState, {status: 'signedOut' | 'locked'}>;
  /** 계좌 개설 직후: 새 아이디를 채워 둔다 */
  initialUsername?: string;
  onOpenAccount?: () => void;
}

export function LoginScreen({state, initialUsername, onOpenAccount}: Props) {
  const {t} = useI18n();
  const method = (b: BiometryType) => BIOMETRY_LABEL[b] || t(b === 'none' ? 'biometry.generic' : 'biometry.biometric');
  const [username, setUsername] = useState(initialUsername ?? 'demo');
  const [password, setPassword] = useState('');
  // Return 키(onSubmitEditing)는 마지막 입력의 onChangeText·재렌더보다 먼저 올 수 있다.
  // 렌더 시점 값을 쓰면 빈 비밀번호가 전송되므로, 입력 즉시 갱신되는 ref와
  // Return 이벤트가 실어 오는 네이티브 입력값(nativeEvent.text)을 쓴다.
  const latest = useRef({username: initialUsername ?? 'demo', password: ''});
  const onUsername = (v: string) => {
    latest.current.username = v;
    setUsername(v);
  };
  const onPassword = (v: string) => {
    latest.current.password = v;
    setPassword(v);
  };
  const submit = (override?: {password?: string}) => {
    // iOS 보안 입력란은 Return 이벤트에 빈 문자열을 실어 올 수 있으니, 값이 있을 때만 쓴다
    if (override?.password) latest.current.password = override.password;
    const {username: u, password: pw} = latest.current;
    if (!u || !pw) return;
    run(() => session.login(u, pw, enableLock));
  };
  const [busy, setBusy] = useState(false);
  const [biometry, setBiometry] = useState<BiometryType>('none');
  const [enableLock, setEnableLock] = useState(false);

  useEffect(() => {
    secureStore
      .biometryType()
      .then(setBiometry)
      .catch(() => setBiometry('none'));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return; // 중복 탭 방지
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'locked') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Hoga</Text>
        <Text style={styles.sub}>{t('login.locked')}</Text>
        {state.message ? <Text style={styles.error}>{t(state.message)}</Text> : null}
        <Pressable testID="unlock" style={styles.primary} onPress={() => run(() => session.unlock())}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryText}>{t('login.unlock', {method: method(biometry)})}</Text>
          )}
        </Pressable>
        <Pressable testID="otherAccount" style={styles.link} onPress={() => run(() => session.logout())}>
          <Text style={styles.linkText}>{t('login.otherAccount')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hoga</Text>
      <Text style={styles.sub}>{t('login.subtitle')}</Text>
      {state.message ? (
        <Text testID="loginError" style={styles.error}>
          {t(state.message)}
        </Text>
      ) : null}
      <TextInput
        testID="username"
        style={styles.input}
        value={username}
        onChangeText={onUsername}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={t('login.username')}
        textContentType="username"
      />
      <TextInput
        testID="password"
        style={styles.input}
        value={password}
        onChangeText={onPassword}
        secureTextEntry
        placeholder={t('login.password')}
        textContentType="password"
        onSubmitEditing={e => submit({password: e.nativeEvent.text})}
      />
      {biometry !== 'none' ? (
        <View style={styles.row}>
          <Text style={styles.rowText}>{t('login.enableLock', {method: method(biometry)})}</Text>
          <Switch value={enableLock} onValueChange={setEnableLock} />
        </View>
      ) : (
        <Text style={styles.hint}>{t('login.noBiometry')}</Text>
      )}
      <Pressable
        testID="login"
        style={[styles.primary, (!username || !password) && styles.disabled]}
        disabled={!username || !password || busy}
        onPress={() => submit()}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{t('login.submit')}</Text>}
      </Pressable>
      {initialUsername ? (
        <Text testID="accountOpened" style={styles.opened}>
          {t('login.accountOpened', {username: initialUsername})}
        </Text>
      ) : (
        <Text style={styles.hint}>{t('login.devHint')}</Text>
      )}
      {onOpenAccount ? (
        <Pressable testID="openAccountOpen" style={styles.link} onPress={onOpenAccount}>
          <Text style={styles.linkText}>{t('login.openAccount')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    gap: 12,
    backgroundColor: colors.bg,
  },
  title: {fontSize: 34, fontWeight: '800', color: colors.accent},
  sub: {color: colors.sub, marginBottom: 12},
  error: {color: colors.danger},
  input: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  rowText: {color: colors.text, fontSize: 15},
  primary: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  disabled: {opacity: 0.4},
  primaryText: {color: '#fff', fontSize: 16, fontWeight: '700'},
  link: {alignItems: 'center', padding: 8},
  linkText: {color: colors.accent},
  hint: {color: colors.mute, fontSize: 12, textAlign: 'center'},
  opened: {color: colors.accent, fontSize: 13, textAlign: 'center', fontWeight: '600'},
});
