import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View} from 'react-native';

import {session, type SessionState} from '../auth/session';
import {secureStore, type BiometryType} from '../native/security';
import {colors} from '../theme';

const BIOMETRY_LABEL: Record<BiometryType, string> = {
  faceId: 'Face ID',
  touchId: 'Touch ID',
  opticId: 'Optic ID',
  biometric: '생체 인증',
  none: '',
};

export function LoginScreen({state}: {state: Extract<SessionState, {status: 'signedOut' | 'locked'}>}) {
  const [username, setUsername] = useState('demo');
  const [password, setPassword] = useState('');
  // Return 키(onSubmitEditing)는 마지막 입력의 onChangeText·재렌더보다 먼저 올 수 있다.
  // 렌더 시점 값을 쓰면 빈 비밀번호가 전송되므로, 입력 즉시 갱신되는 ref와
  // Return 이벤트가 실어 오는 네이티브 입력값(nativeEvent.text)을 쓴다.
  const latest = useRef({username: 'demo', password: ''});
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
    secureStore.biometryType().then(setBiometry).catch(() => setBiometry('none'));
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
        <Text style={styles.sub}>잠금 상태입니다</Text>
        {state.message ? <Text style={styles.error}>{state.message}</Text> : null}
        <Pressable testID="unlock" style={styles.primary} onPress={() => run(() => session.unlock())}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{BIOMETRY_LABEL[biometry] || '인증'}으로 잠금 해제</Text>}
        </Pressable>
        <Pressable style={styles.link} onPress={() => run(() => session.logout())}>
          <Text style={styles.linkText}>다른 계정으로 로그인</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hoga</Text>
      <Text style={styles.sub}>모의 거래소 · 개발용 계정</Text>
      {state.message ? <Text testID="loginError" style={styles.error}>{state.message}</Text> : null}
      <TextInput
        testID="username"
        style={styles.input}
        value={username}
        onChangeText={onUsername}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="아이디"
        textContentType="username"
      />
      <TextInput
        testID="password"
        style={styles.input}
        value={password}
        onChangeText={onPassword}
        secureTextEntry
        placeholder="비밀번호"
        textContentType="password"
        onSubmitEditing={e => submit({password: e.nativeEvent.text})}
      />
      {biometry !== 'none' ? (
        <View style={styles.row}>
          <Text style={styles.rowText}>{BIOMETRY_LABEL[biometry]}로 앱 잠금</Text>
          <Switch value={enableLock} onValueChange={setEnableLock} />
        </View>
      ) : (
        <Text style={styles.hint}>이 기기에는 등록된 생체 인증이 없어 잠금 없이 로그인합니다.</Text>
      )}
      <Pressable
        testID="login"
        style={[styles.primary, (!username || !password) && styles.disabled]}
        disabled={!username || !password || busy}
        onPress={() => submit()}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>로그인</Text>}
      </Pressable>
      <Text style={styles.hint}>개발용: demo / hoga-demo-1234</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, padding: 24, justifyContent: 'center', gap: 12, backgroundColor: colors.bg},
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
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4},
  rowText: {color: colors.text, fontSize: 15},
  primary: {backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 4},
  disabled: {opacity: 0.4},
  primaryText: {color: '#fff', fontSize: 16, fontWeight: '700'},
  link: {alignItems: 'center', padding: 8},
  linkText: {color: colors.accent},
  hint: {color: colors.mute, fontSize: 12, textAlign: 'center'},
});
