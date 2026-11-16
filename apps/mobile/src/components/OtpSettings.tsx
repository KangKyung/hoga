/**
 * 설정 → 주문 OTP. 등록(QR·키 표시 → 코드로 확인) / 해제(코드 필요).
 * 시드는 이 화면에서만 잠깐 보이고 앱에 저장하지 않는다.
 */
import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';

import {otp, type OtpErrorCode} from '../auth/otp';
import {t} from '../i18n';
import {colors, mono} from '../theme';
import {QrCode} from './QrCode';

type State =
  | {kind: 'loading'}
  | {kind: 'off'}
  | {kind: 'enrolling'; secret: string; url: string}
  | {kind: 'on'}
  | {kind: 'error'};

const errorText = (e: OtpErrorCode) =>
  t(e === 'OTP_LOCKED' ? 'settings.otpLocked' : e === 'NETWORK' ? 'session.unreachable' : 'settings.otpInvalid');

export function OtpSettings() {
  const [state, setState] = useState<State>({kind: 'loading'});
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    otp.status().then(r => setState(r.ok ? {kind: r.data.enabled ? 'on' : 'off'} : {kind: 'error'}));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const enroll = () =>
    run(async () => {
      const r = await otp.enroll();
      if (r.ok) setState({kind: 'enrolling', secret: r.data.secret, url: r.data.otpauthUrl});
      else setError(errorText(r.error));
    });

  const confirm = () =>
    run(async () => {
      const r = state.kind === 'enrolling' ? await otp.confirm(code) : await otp.disable(code);
      setCode('');
      if (r.ok) setState({kind: r.data.enabled ? 'on' : 'off'});
      else setError(errorText(r.error));
    });

  const codeInput = (
    <TextInput
      testID="otpSettingsCode"
      value={code}
      onChangeText={v => setCode(v.replace(/\D/g, '').slice(0, 6))}
      placeholder={t('settings.otpCodePlaceholder')}
      placeholderTextColor={colors.mute}
      keyboardType="number-pad"
      maxLength={6}
      style={[styles.input, mono]}
    />
  );

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.section}>{t('settings.otp')}</Text>
        {busy || state.kind === 'loading' ? <ActivityIndicator /> : null}
      </View>
      {state.kind === 'on' || state.kind === 'off' ? (
        <Text testID="otpStatus" style={[styles.status, state.kind === 'on' && styles.on]}>
          {t(state.kind === 'on' ? 'settings.otpOn' : 'settings.otpOff')}
        </Text>
      ) : null}

      {state.kind === 'off' ? (
        <Pressable testID="otpEnroll" style={styles.button} onPress={enroll} disabled={busy}>
          <Text style={styles.buttonText}>{t('settings.otpEnroll')}</Text>
        </Pressable>
      ) : null}

      {state.kind === 'enrolling' ? (
        <View style={styles.enroll}>
          <Text style={styles.hint}>{t('settings.otpEnrollHint')}</Text>
          <View style={styles.qr}>
            <QrCode testID="otpQr" value={state.url} />
          </View>
          <Text style={styles.key}>{t('settings.otpKey')}</Text>
          <Text testID="otpSecret" selectable style={[styles.secret, mono]}>
            {state.secret.replace(/(.{4})/g, '$1 ').trim()}
          </Text>
          {codeInput}
          <Pressable
            testID="otpConfirm"
            style={[styles.button, code.length !== 6 && styles.disabled]}
            disabled={code.length !== 6 || busy}
            onPress={confirm}>
            <Text style={styles.buttonText}>{t('settings.otpConfirm')}</Text>
          </Pressable>
        </View>
      ) : null}

      {state.kind === 'on' ? (
        <View style={styles.enroll}>
          {codeInput}
          <Pressable
            testID="otpDisable"
            style={[styles.button, styles.danger, code.length !== 6 && styles.disabled]}
            disabled={code.length !== 6 || busy}
            onPress={confirm}>
            <Text style={styles.buttonText}>{t('settings.otpDisable')}</Text>
          </Pressable>
        </View>
      ) : null}

      {error ? (
        <Text testID="otpSettingsError" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {backgroundColor: colors.card, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 14, paddingBottom: 12},
  head: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  section: {fontSize: 13, fontWeight: '700', color: colors.sub, paddingVertical: 8},
  status: {fontSize: 14, color: colors.sub, paddingBottom: 8},
  on: {color: colors.live, fontWeight: '600'},
  enroll: {gap: 10},
  hint: {fontSize: 12, color: colors.mute},
  qr: {alignItems: 'center', paddingVertical: 6},
  key: {fontSize: 12, color: colors.mute},
  secret: {fontSize: 15, color: colors.text, letterSpacing: 1},
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 20,
    letterSpacing: 6,
    textAlign: 'center',
    color: colors.text,
  },
  button: {backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 12, alignItems: 'center'},
  danger: {backgroundColor: colors.danger},
  disabled: {opacity: 0.4},
  buttonText: {color: '#fff', fontWeight: '700', fontSize: 15},
  error: {color: colors.danger, fontSize: 13, paddingTop: 8},
});
