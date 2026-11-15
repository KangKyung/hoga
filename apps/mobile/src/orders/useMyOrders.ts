import {useCallback, useEffect, useState} from 'react';

import {hogaCore, type OrderEvent} from '../native/hogaCore';
import {useConnectionState} from '../hooks/market';
import {orderService} from './orderService';
import type {OrderRecord} from './types';

/**
 * 한 종목의 내 주문 목록.
 * - 처음과 재연결될 때마다 REST로 전체를 다시 받는다(끊긴 동안의 변화 반영).
 * - 그 사이 변화는 서버 order 이벤트(C++ → JS push)로 바로 반영한다.
 */
export function useMyOrders(symbol: string) {
  const connection = useConnectionState();
  const [orders, setOrders] = useState<OrderRecord[]>([]);

  const reload = useCallback(() => {
    orderService
      .list(symbol)
      .then(setOrders)
      .catch(() => {});
  }, [symbol]);

  useEffect(() => {
    if (connection === 'open') reload();
  }, [connection, reload]);

  useEffect(() => {
    const sub = hogaCore.onOrderEvent((e: OrderEvent) => {
      if (e.symbol !== symbol) return;
      setOrders(prev => {
        const existing = prev.find(o => o.key === e.key);
        const merged: OrderRecord = {
          ...(existing ?? {fills: [], reject: 'NONE', acceptedAt: e.ts}),
          key: e.key,
          orderId: e.orderId,
          symbol: e.symbol,
          side: e.side,
          type: e.type,
          price: e.price,
          qty: e.qty,
          status: e.status,
          filled: e.filled,
          resting: e.resting,
          updatedAt: e.ts,
        } as OrderRecord;
        return existing ? prev.map(o => (o.key === e.key ? merged : o)) : [merged, ...prev];
      });
    });
    return () => sub.remove();
  }, [symbol]);

  return {orders, reload};
}
