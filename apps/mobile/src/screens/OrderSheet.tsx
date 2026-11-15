import React, {useMemo, useState} from 'react';
import {ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';

import type {SymbolInfo} from '../api/symbols';
import {hogaCore} from '../native/hogaCore';
import {UNCONFIRMED, type OrderProgress} from '../orders/placeOrder';
import {orderService} from '../orders/orderService';
import type {OrderType, Side} from '../orders/types';
import {colors, formatPrice, mono} from '../theme';

const REJECT_TEXT: Record<string, string> = {
  INVALID_QTY: '수량을 확인하세요',
  QTY_TOO_LARGE: '1회 최대 수량을 넘었습니다',
  INVALID_PRICE: '가격을 확인하세요',
  OFF_TICK: '호가 단위에 맞지 않는 가격입니다',
  OUT_OF_PRICE_LIMIT: '상·하한가 범위를 벗어났습니다',
  NO_LIQUIDITY: '체결할 상대 호가가 없습니다',
  IDEMPOTENCY_KEY_REUSED: '주문 키가 중복되었습니다',
  UNAUTHORIZED: '다시 로그인해 주세요',
};

interface Props {
  symbol: SymbolInfo;
  initialSide: Side;
  initialPrice: number;
  onClose: () => void;
}

export function OrderSheet({symbol, initialSide, initialPrice, onClose}: Props) {
  const [side, setSide] = useState<Side>(initialSide);
  const [type, setType] = useState<OrderType>('limit');
  const [price, setPrice] = useState(initialPrice);
  const [qtyText, setQtyText] = useState('10');
  const [progress, setProgress] = useState<OrderProgress | null>(null);

  const qty = Number(qtyText);
  const limits = useMemo(() => hogaCore.priceLimits(symbol.basePrice), [symbol.basePrice]);
  // 서버와 같은 C++ 규칙으로 미리 검사 → 보내기 전에 막는다
  const reject = hogaCore.validateOrder(side, type, type === 'limit' ? price : 0, Number.isFinite(qty) ? qty : 0, symbol.basePrice);
  const inFlight = progress?.phase === 'submitting' || progress?.phase === 'confirming';
  const done = progress?.phase === 'accepted' || progress?.phase === 'rejected' || progress?.phase === 'failed';
  const tint = side === 'bid' ? colors.up : colors.down;

  // 다음/이전 호가: 가격대 경계에서도 단위가 맞도록 C++ roundToTick 사용
  const step = (dir: 1 | -1) =>
    setPrice(p => {
      const next = dir > 0 ? hogaCore.roundToTick(p + 1, 'up') : hogaCore.roundToTick(p - 1, 'down');
      return Math.min(limits.upper, Math.max(limits.lower, next));
    });

  const submit = async () => {
    if (inFlight || reject !== 'NONE') return; // 중복 탭·잘못된 주문 차단
    await orderService.place(
      {symbol: symbol.code, side, type, price: type === 'limit' ? price : 0, qty},
      setProgress,
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
              <Text style={[styles.close, inFlight && styles.disabledText]}>닫기</Text>
            </Pressable>
          </View>

          <View style={styles.segment}>
            {(['bid', 'ask'] as const).map(s => (
              <Pressable
                key={s}
                testID={`side-${s}`}
                disabled={inFlight}
                onPress={() => setSide(s)}
                style={[styles.segmentItem, side === s && {backgroundColor: s === 'bid' ? colors.up : colors.down}]}>
                <Text style={[styles.segmentText, side === s && styles.segmentTextActive]}>{s === 'bid' ? '매수' : '매도'}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.segment}>
            {(['limit', 'market'] as const).map(t => (
              <Pressable
                key={t}
                disabled={inFlight}
                onPress={() => setType(t)}
                style={[styles.segmentItem, type === t && styles.segmentNeutral]}>
                <Text style={[styles.segmentText, type === t && styles.segmentTextActive]}>{t === 'limit' ? '지정가' : '시장가'}</Text>
              </Pressable>
            ))}
          </View>

          {type === 'limit' ? (
            <View style={styles.field}>
              <Text style={styles.label}>가격 (호가단위 {formatPrice(hogaCore.tickSize(price))}원)</Text>
              <View style={styles.stepper}>
                <Pressable testID="priceDown" style={styles.stepBtn} onPress={() => step(-1)} disabled={inFlight}>
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text testID="orderPrice" style={[styles.value, mono]}>{formatPrice(price)}</Text>
                <Pressable testID="priceUp" style={styles.stepBtn} onPress={() => step(1)} disabled={inFlight}>
                  <Text style={styles.stepText}>+</Text>
                </Pressable>
              </View>
              <Text style={styles.hint}>
                하한가 {formatPrice(limits.lower)} · 상한가 {formatPrice(limits.upper)}
              </Text>
            </View>
          ) : null}

          <View style={styles.field}>
            <Text style={styles.label}>수량 (주)</Text>
            <TextInput
              testID="orderQty"
              style={[styles.qtyInput, mono]}
              value={qtyText}
              onChangeText={t => setQtyText(t.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              editable={!inFlight}
            />
          </View>

          {type === 'limit' && reject === 'NONE' ? (
            <Text style={[styles.amount, mono]}>주문 금액 {formatPrice(price * qty)}원</Text>
          ) : null}
          {reject !== 'NONE' && !progress ? <Text style={styles.error}>{REJECT_TEXT[reject] ?? reject}</Text> : null}

          {progress ? <ProgressView progress={progress} /> : null}

          {done ? (
            <Pressable testID="orderDone" style={[styles.submit, styles.segmentNeutral]} onPress={onClose}>
              <Text style={styles.submitText}>확인</Text>
            </Pressable>
          ) : (
            <Pressable
              testID="submitOrder"
              style={[styles.submit, {backgroundColor: tint}, (reject !== 'NONE' || inFlight) && styles.disabled]}
              disabled={reject !== 'NONE' || inFlight}
              onPress={submit}>
              {inFlight ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{side === 'bid' ? '매수' : '매도'} 주문</Text>}
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
      text = attempt > 1 ? `같은 주문 번호로 다시 보내는 중 (${attempt}회차)` : '주문 전송 중…';
      break;
    case 'confirming':
      text = '응답이 늦어 접수 여부를 확인하는 중…';
      color = colors.warn;
      break;
    case 'accepted':
      text =
        record?.status === 'FILLED'
          ? `전량 체결 (${formatPrice(record.filled)}주)`
          : record && record.filled > 0
            ? `일부 체결 ${formatPrice(record.filled)}주 · 대기 ${formatPrice(record.resting)}주`
            : '주문이 접수되었습니다';
      color = colors.live;
      break;
    case 'rejected':
      text = `주문 거부: ${REJECT_TEXT[message ?? ''] ?? message}`;
      color = colors.danger;
      break;
    case 'failed':
      text =
        message === UNCONFIRMED
          ? '주문 결과를 확인하지 못했습니다. 다시 주문하지 말고 주문 내역을 확인하세요.'
          : `주문 실패: ${REJECT_TEXT[message ?? ''] ?? message}`;
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
  backdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)'},
  sheet: {backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, gap: 12, paddingBottom: 36},
  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  title: {fontSize: 18, fontWeight: '700', color: colors.text},
  code: {fontSize: 13, fontWeight: '400', color: colors.mute},
  close: {color: colors.accent, fontSize: 15},
  disabledText: {opacity: 0.4},
  segment: {flexDirection: 'row', backgroundColor: colors.bg, borderRadius: 10, padding: 3},
  segmentItem: {flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 8},
  segmentNeutral: {backgroundColor: colors.accent},
  segmentText: {fontWeight: '600', color: colors.sub},
  segmentTextActive: {color: '#fff'},
  field: {gap: 6},
  label: {fontSize: 12, color: colors.mute},
  stepper: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  stepBtn: {width: 48, height: 44, borderRadius: 10, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center'},
  stepText: {fontSize: 22, color: colors.text},
  value: {fontSize: 22, fontWeight: '700', color: colors.text},
  hint: {fontSize: 12, color: colors.mute, textAlign: 'center'},
  qtyInput: {borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 18, color: colors.text},
  amount: {textAlign: 'right', color: colors.sub},
  error: {color: colors.danger},
  progress: {fontSize: 14, fontWeight: '600'},
  submit: {borderRadius: 10, paddingVertical: 15, alignItems: 'center'},
  submitText: {color: '#fff', fontSize: 16, fontWeight: '700'},
  disabled: {opacity: 0.4},
});
