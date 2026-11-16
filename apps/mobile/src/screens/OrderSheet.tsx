import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';

import {accountApi, type Orderable} from '../api/account';
import type {SymbolInfo} from '../api/symbols';
import {useBook} from '../hooks/market';
import {useSubscription} from '../market/subscriptions';
import {hogaCore} from '../native/hogaCore';
import {OTP_CANCELLED, UNCONFIRMED, type OrderProgress} from '../orders/placeOrder';
import {otp} from '../auth/otp';
import {orderService} from '../orders/orderService';
import type {OrderType, Side} from '../orders/types';
import {track} from '../analytics/analytics';
import {t, useI18n} from '../i18n';
import {colors, formatPrice, mono} from '../theme';

/** 거부 코드 → 문구. 모르는 코드는 코드 그대로 보여 준다 */
const rejectText = (code: string | undefined) => {
  const key = `reject.${code ?? ''}`;
  const text = t(key);
  return text === key ? code ?? '' : text;
};

export type OrderEntry = 'book' | 'button' | 'web' | 'account';

/** 정정: 원주문 키·미체결 잔량. 매수/매도·지정가는 바꿀 수 없고 가격·수량(잔량 이하)만 */
export interface AmendTarget {
  key: string;
  resting: number;
}

interface Props {
  symbol: SymbolInfo;
  initialSide: Side;
  initialPrice: number;
  /** 어디서 열었는지(분석용). web이면 웹 화면에서 연 주문이라고 알려 준다 */
  entry?: OrderEntry;
  amend?: AmendTarget;
  onClose: () => void;
}

/** 주문가능 조회를 가격 변경마다 바로 하지 않고 잠깐 모아서 */
const ORDERABLE_DEBOUNCE_MS = 250;

export function OrderSheet({symbol, initialSide, initialPrice, entry = 'button', amend, onClose}: Props) {
  useI18n();
  // 주문 창이 떠 있는 동안은 이 종목의 매매 상태(장 구간·VI)를 받아야 한다(계좌 화면에서 열 때도)
  useSubscription([symbol.code]);
  const session = useBook(symbol.code, 1).session;
  const [side, setSide] = useState<Side>(initialSide);
  const [type, setType] = useState<OrderType>('limit');
  const [price, setPrice] = useState(initialPrice);
  const [qtyText, setQtyText] = useState(String(amend?.resting ?? 10));
  const [orderable, setOrderable] = useState<Orderable | null>(null);
  const [progress, setProgress] = useState<OrderProgress | null>(null);
  // OTP 입력을 기다리는 주문(placeOrder가 await 중). true = 인증 끝, false = 취소
  const otpWaiter = useRef<((ok: boolean) => void) | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpBusy, setOtpBusy] = useState(false);

  const qty = Number(qtyText);
  const limits = useMemo(() => hogaCore.priceLimits(symbol.basePrice), [symbol.basePrice]);
  const safeQty = Number.isFinite(qty) ? qty : 0;
  const orderPrice = type === 'limit' ? price : 0;

  // 주문가능(서버 원장). 매수/매도·가격·유형이 바뀌면 다시
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      accountApi
        .orderable({symbol: symbol.code, side, type, price})
        .then(o => alive && setOrderable(o))
        .catch(() => alive && setOrderable(null));
    }, ORDERABLE_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [symbol.code, side, type, price, progress?.phase]);

  // 서버와 같은 C++ 규칙으로 미리 검사 → 보내기 전에 막는다
  //  1) 호가단위·가격제한폭·수량  2) 장 구간(장 종료·단일가 시장가)  3) 주문가능금액·매도가능수량
  const rule = hogaCore.validateOrder(side, type, orderPrice, safeQty, symbol.basePrice);
  const sessionReject =
    session.mode === 'HALTED' ? 'MARKET_CLOSED' : session.mode === 'AUCTION' && type === 'market' ? 'MARKET_IN_AUCTION' : 'NONE';
  const accountReject = amend
    ? safeQty > amend.resting
      ? 'EXCEEDS_OPEN_QTY'
      : 'NONE' // 정정은 원주문이 묶어 둔 금액을 옮기므로 서버가 최종 확인
    : orderable
    ? hogaCore.checkAccount(side, type, orderPrice, safeQty, orderable, limits.upper)
    : 'NONE';
  const reject = rule !== 'NONE' ? rule : sessionReject !== 'NONE' ? sessionReject : accountReject;
  const maxQty = amend ? amend.resting : orderable?.maxQty ?? 0;
  const inFlight = progress?.phase === 'submitting' || progress?.phase === 'confirming';
  const done = progress?.phase === 'accepted' || progress?.phase === 'rejected' || progress?.phase === 'failed';
  const askingOtp = progress?.phase === 'otp';

  const requestOtp = () =>
    new Promise<boolean>(resolve => {
      setOtpCode('');
      setOtpError(null);
      otpWaiter.current = resolve;
    });

  const submitOtp = async (code = otpCode) => {
    if (otpBusy || !/^\d{6}$/.test(code)) return;
    setOtpBusy(true);
    const r = await otp.verify(code);
    setOtpBusy(false);
    if (r.ok) {
      otpWaiter.current?.(true);
      otpWaiter.current = null;
    } else {
      setOtpCode('');
      setOtpError(
        t(r.error === 'OTP_LOCKED' ? 'order.otpLocked' : r.error === 'NETWORK' ? 'session.unreachable' : 'order.otpInvalid'),
      );
    }
  };

  const cancelOtp = () => {
    otpWaiter.current?.(false);
    otpWaiter.current = null;
  };

  const close = () => {
    cancelOtp();
    onClose();
  };
  const tint = side === 'bid' ? colors.up : colors.down;
  const sawConfirming = useRef(false);

  useEffect(() => {
    track('open_order_sheet', {
      symbol: symbol.code,
      side: initialSide,
      entry,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onProgress = (p: OrderProgress) => {
    setProgress(p);
    if (p.phase === 'confirming') sawConfirming.current = true;
    const result =
      p.phase === 'accepted'
        ? p.record?.status === 'FILLED'
          ? 'filled'
          : p.record && p.record.filled > 0
          ? 'partial'
          : 'accepted'
        : p.phase === 'rejected'
        ? 'rejected'
        : p.phase === 'failed'
        ? p.message === UNCONFIRMED
          ? 'unknown'
          : 'failed'
        : null;
    if (result) {
      track('order_result', {
        symbol: symbol.code,
        result,
        confirmed_by_lookup: sawConfirming.current,
      });
    }
  };

  // 다음/이전 호가: 가격대 경계에서도 단위가 맞도록 C++ roundToTick 사용
  const step = (dir: 1 | -1) =>
    setPrice(p => {
      const next = dir > 0 ? hogaCore.roundToTick(p + 1, 'up') : hogaCore.roundToTick(p - 1, 'down');
      return Math.min(limits.upper, Math.max(limits.lower, next));
    });

  const submit = async () => {
    if (inFlight || reject !== 'NONE') return; // 중복 탭·잘못된 주문 차단
    track(amend ? 'submit_amend' : 'submit_order', {symbol: symbol.code, side, order_type: type});
    await orderService.place(
      {
        symbol: symbol.code,
        side,
        type,
        price: type === 'limit' ? price : 0,
        qty,
        ...(amend ? {amendOf: amend.key} : {}),
      },
      onProgress,
      requestOtp,
    );
  };

  return (
    <Modal transparent animationType="slide" visible onRequestClose={inFlight ? undefined : close}>
      {/* 숫자 키패드가 시트 아래(OTP 입력·확인 버튼)를 가리지 않게 시트를 올린다.
          Android의 Modal은 별도 창이라 adjustResize가 적용되지 않아 두 플랫폼 모두 padding으로 */}
      <KeyboardAvoidingView style={styles.backdrop} behavior="padding">
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>
              {symbol.name} <Text style={styles.code}>{symbol.code}</Text>
              {amend ? <Text style={styles.amendTag}>{`  ${t('order.amendTitle')}`}</Text> : null}
            </Text>
            <Pressable testID="closeOrder" disabled={inFlight} onPress={close} hitSlop={12}>
              <Text style={[styles.close, inFlight && styles.disabledText]}>{t('common.close')}</Text>
            </Pressable>
          </View>

          {entry === 'web' ? (
            <Text testID="fromWebNotice" style={styles.notice}>
              {t('order.fromWeb')}
            </Text>
          ) : null}

          <View style={styles.segment}>
            {(['bid', 'ask'] as const).map(s => (
              <Pressable
                key={s}
                testID={`side-${s}`}
                disabled={inFlight || Boolean(amend)}
                onPress={() => setSide(s)}
                style={[
                  styles.segmentItem,
                  side === s && {
                    backgroundColor: s === 'bid' ? colors.up : colors.down,
                  },
                ]}>
                <Text style={[styles.segmentText, side === s && styles.segmentTextActive]}>
                  {t(s === 'bid' ? 'common.buy' : 'common.sell')}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.segment}>
            {(['limit', 'market'] as const).map(o => (
              <Pressable
                key={o}
                testID={`type-${o}`}
                disabled={inFlight || Boolean(amend) || (o === 'market' && session.mode === 'AUCTION')}
                onPress={() => setType(o)}
                style={[styles.segmentItem, type === o && styles.segmentNeutral]}>
                <Text style={[styles.segmentText, type === o && styles.segmentTextActive]}>
                  {t(o === 'limit' ? 'common.limit' : 'common.market')}
                </Text>
              </Pressable>
            ))}
          </View>

          {type === 'limit' ? (
            <View style={styles.field}>
              <Text style={styles.label}>
                {t('order.price', {
                  tick: formatPrice(hogaCore.tickSize(price)),
                })}
              </Text>
              <View style={styles.stepper}>
                <Pressable testID="priceDown" style={styles.stepBtn} onPress={() => step(-1)} disabled={inFlight}>
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text testID="orderPrice" style={[styles.value, mono]}>
                  {formatPrice(price)}
                </Text>
                <Pressable testID="priceUp" style={styles.stepBtn} onPress={() => step(1)} disabled={inFlight}>
                  <Text style={styles.stepText}>+</Text>
                </Pressable>
              </View>
              <Text style={styles.hint}>
                {t('order.limits', {
                  lower: formatPrice(limits.lower),
                  upper: formatPrice(limits.upper),
                })}
              </Text>
            </View>
          ) : null}

          <View style={styles.field}>
            <View style={styles.qtyLabelRow}>
              <Text style={styles.label}>{t('order.qty')}</Text>
              <Text testID="orderable" style={[styles.orderable, mono]}>
                {amend
                  ? t('order.amendable', {qty: formatPrice(amend.resting)})
                  : orderable
                  ? t(side === 'bid' ? 'order.orderableBuy' : 'order.orderableSell', {
                      qty: formatPrice(orderable.maxQty),
                      cash: formatPrice(orderable.availableCash),
                    })
                  : ''}
              </Text>
              <Pressable
                testID="maxQty"
                disabled={inFlight || maxQty <= 0}
                onPress={() => setQtyText(String(maxQty))}
                hitSlop={8}
                style={[styles.maxBtn, maxQty <= 0 && styles.disabled]}>
                <Text style={styles.maxText}>{t('order.max')}</Text>
              </Pressable>
            </View>
            <TextInput
              testID="orderQty"
              style={[styles.qtyInput, mono]}
              value={qtyText}
              onChangeText={v => setQtyText(v.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              editable={!inFlight}
            />
          </View>

          {type === 'limit' && reject === 'NONE' ? (
            <Text style={[styles.amount, mono]}>{t('order.amount', {amount: formatPrice(price * qty)})}</Text>
          ) : null}
          {reject !== 'NONE' && !progress ? <Text style={styles.error}>{rejectText(reject)}</Text> : null}

          {progress ? <ProgressView progress={progress} /> : null}

          {askingOtp ? (
            <View style={styles.otpBox}>
              <TextInput
                testID="otpCode"
                value={otpCode}
                onChangeText={v => {
                  const code = v.replace(/\D/g, '').slice(0, 6);
                  setOtpCode(code);
                  // 6자리가 차면 바로 확인(iOS 숫자 키패드에는 Return 키가 없다)
                  if (code.length === 6) submitOtp(code);
                }}
                onSubmitEditing={() => submitOtp()}
                placeholder={t('order.otpPlaceholder')}
                placeholderTextColor={colors.mute}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                style={[styles.otpInput, mono]}
              />
              {otpError ? (
                <Text testID="otpError" style={styles.error}>
                  {otpError}
                </Text>
              ) : null}
              <View style={styles.otpActions}>
                <Pressable testID="otpCancel" style={[styles.otpBtn, styles.otpCancelBtn]} onPress={cancelOtp}>
                  <Text style={styles.otpBtnText}>{t('order.otpCancel')}</Text>
                </Pressable>
                <Pressable
                  testID="otpSubmit"
                  style={[styles.otpBtn, {backgroundColor: tint}, (otpCode.length !== 6 || otpBusy) && styles.disabled]}
                  disabled={otpCode.length !== 6 || otpBusy}
                  onPress={() => submitOtp()}>
                  <Text style={[styles.otpBtnText, styles.otpBtnTextOn]}>{t('order.otpSubmit')}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {done ? (
            <Pressable testID="orderDone" style={[styles.submit, styles.segmentNeutral]} onPress={onClose}>
              <Text style={styles.submitText}>{t('common.confirm')}</Text>
            </Pressable>
          ) : (
            <Pressable
              testID="submitOrder"
              style={[styles.submit, {backgroundColor: tint}, (reject !== 'NONE' || inFlight || askingOtp) && styles.disabled]}
              // OTP를 기다리는 동안 다시 누르면 같은 주문이 하나 더 시작된다 → 막는다
              disabled={reject !== 'NONE' || inFlight || askingOtp}
              onPress={submit}>
              {inFlight ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitText}>
                  {amend
                    ? t('order.amendSubmit')
                    : t('order.submit', {
                        side: t(side === 'bid' ? 'common.buy' : 'common.sell'),
                      })}
                </Text>
              )}
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ProgressView({progress}: {progress: OrderProgress}) {
  const {phase, record, message, attempt} = progress;
  let text = '';
  let color = colors.sub;
  switch (phase) {
    case 'submitting':
      text = attempt > 1 ? t('order.retrying', {attempt}) : t('order.sending');
      break;
    case 'confirming':
      text = t('order.confirming');
      color = colors.warn;
      break;
    case 'otp':
      text = t('order.otpRequired');
      color = colors.warn;
      break;
    case 'accepted':
      text =
        record?.status === 'FILLED'
          ? t('order.filled', {filled: formatPrice(record.filled)})
          : record && record.filled > 0
          ? t('order.partial', {
              filled: formatPrice(record.filled),
              resting: formatPrice(record.resting),
            })
          : t('order.accepted');
      color = colors.live;
      break;
    case 'rejected':
      text = t('order.rejected', {reason: rejectText(message)});
      color = colors.danger;
      break;
    case 'failed':
      text =
        message === UNCONFIRMED
          ? t('order.unknown')
          : message === OTP_CANCELLED
          ? t('order.otpCancelled')
          : t('order.failed', {reason: rejectText(message)});
      color = colors.danger;
      break;
  }
  return (
    <Text testID="orderProgress" style={[styles.progress, {color}]}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    gap: 12,
    paddingBottom: 36,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {fontSize: 18, fontWeight: '700', color: colors.text},
  code: {fontSize: 13, fontWeight: '400', color: colors.mute},
  close: {color: colors.accent, fontSize: 15},
  disabledText: {opacity: 0.4},
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderRadius: 10,
    padding: 3,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    borderRadius: 8,
  },
  segmentNeutral: {backgroundColor: colors.accent},
  segmentText: {fontWeight: '600', color: colors.sub},
  segmentTextActive: {color: '#fff'},
  field: {gap: 6},
  label: {fontSize: 12, color: colors.mute},
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepBtn: {
    width: 48,
    height: 44,
    borderRadius: 10,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: {fontSize: 22, color: colors.text},
  value: {fontSize: 22, fontWeight: '700', color: colors.text},
  hint: {fontSize: 12, color: colors.mute, textAlign: 'center'},
  qtyInput: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 18,
    color: colors.text,
  },
  amount: {textAlign: 'right', color: colors.sub},
  qtyLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  orderable: {flex: 1, textAlign: 'right', fontSize: 12, color: colors.sub},
  maxBtn: {paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: colors.line},
  maxText: {fontSize: 12, fontWeight: '700', color: colors.accent},
  amendTag: {fontSize: 14, fontWeight: '700', color: colors.accent},
  error: {color: colors.danger},
  notice: {
    fontSize: 13,
    color: colors.warn,
    backgroundColor: 'rgba(194, 122, 0, 0.08)',
    borderRadius: 8,
    padding: 10,
  },
  progress: {fontSize: 14, fontWeight: '600'},
  otpBox: {gap: 8},
  otpInput: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 22,
    letterSpacing: 6,
    textAlign: 'center',
    color: colors.text,
  },
  otpActions: {flexDirection: 'row', gap: 8},
  otpBtn: {flex: 1, borderRadius: 8, paddingVertical: 12, alignItems: 'center'},
  otpCancelBtn: {borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card},
  otpBtnText: {fontSize: 15, fontWeight: '700', color: colors.text},
  otpBtnTextOn: {color: '#fff'},
  submit: {borderRadius: 10, paddingVertical: 15, alignItems: 'center'},
  submitText: {color: '#fff', fontSize: 16, fontWeight: '700'},
  disabled: {opacity: 0.4},
});
