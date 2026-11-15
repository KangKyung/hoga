import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';

import type {SymbolInfo} from '../api/symbols';
import {hogaCore} from '../native/hogaCore';
import {UNCONFIRMED, type OrderProgress} from '../orders/placeOrder';
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

export type OrderEntry = 'book' | 'button' | 'web';

interface Props {
  symbol: SymbolInfo;
  initialSide: Side;
  initialPrice: number;
  /** 어디서 열었는지(분석용). web이면 웹 화면에서 연 주문이라고 알려 준다 */
  entry?: OrderEntry;
  onClose: () => void;
}

export function OrderSheet({symbol, initialSide, initialPrice, entry = 'button', onClose}: Props) {
  useI18n();
  const [side, setSide] = useState<Side>(initialSide);
  const [type, setType] = useState<OrderType>('limit');
  const [price, setPrice] = useState(initialPrice);
  const [qtyText, setQtyText] = useState('10');
  const [progress, setProgress] = useState<OrderProgress | null>(null);

  const qty = Number(qtyText);
  const limits = useMemo(() => hogaCore.priceLimits(symbol.basePrice), [symbol.basePrice]);
  // 서버와 같은 C++ 규칙으로 미리 검사 → 보내기 전에 막는다
  const reject = hogaCore.validateOrder(
    side,
    type,
    type === 'limit' ? price : 0,
    Number.isFinite(qty) ? qty : 0,
    symbol.basePrice,
  );
  const inFlight = progress?.phase === 'submitting' || progress?.phase === 'confirming';
  const done = progress?.phase === 'accepted' || progress?.phase === 'rejected' || progress?.phase === 'failed';
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
    track('submit_order', {symbol: symbol.code, side, order_type: type});
    await orderService.place(
      {
        symbol: symbol.code,
        side,
        type,
        price: type === 'limit' ? price : 0,
        qty,
      },
      onProgress,
    );
  };

  return (
    <Modal transparent animationType="slide" visible onRequestClose={inFlight ? undefined : onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>
              {symbol.name} <Text style={styles.code}>{symbol.code}</Text>
            </Text>
            <Pressable testID="closeOrder" disabled={inFlight} onPress={onClose} hitSlop={12}>
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
                disabled={inFlight}
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
                disabled={inFlight}
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
            <Text style={styles.label}>{t('order.qty')}</Text>
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

          {done ? (
            <Pressable testID="orderDone" style={[styles.submit, styles.segmentNeutral]} onPress={onClose}>
              <Text style={styles.submitText}>{t('common.confirm')}</Text>
            </Pressable>
          ) : (
            <Pressable
              testID="submitOrder"
              style={[styles.submit, {backgroundColor: tint}, (reject !== 'NONE' || inFlight) && styles.disabled]}
              disabled={reject !== 'NONE' || inFlight}
              onPress={submit}>
              {inFlight ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitText}>
                  {t('order.submit', {
                    side: t(side === 'bid' ? 'common.buy' : 'common.sell'),
                  })}
                </Text>
              )}
            </Pressable>
          )}
        </View>
      </View>
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
      text = message === UNCONFIRMED ? t('order.unknown') : t('order.failed', {reason: rejectText(message)});
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
  error: {color: colors.danger},
  notice: {
    fontSize: 13,
    color: colors.warn,
    backgroundColor: 'rgba(194, 122, 0, 0.08)',
    borderRadius: 8,
    padding: 10,
  },
  progress: {fontSize: 14, fontWeight: '600'},
  submit: {borderRadius: 10, paddingVertical: 15, alignItems: 'center'},
  submitText: {color: '#fff', fontSize: 16, fontWeight: '700'},
  disabled: {opacity: 0.4},
});
