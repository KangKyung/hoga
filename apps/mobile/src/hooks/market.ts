import {useEffect, useState} from 'react';

import {BOOK_REFRESH_HZ, STALE_AFTER_MS} from '../config';
import {hogaCore, type BookView, type ClientStats, type ConnectionState, type Trade} from '../native/hogaCore';
import {usePolled} from './usePolled';

export interface BookState extends BookView {
  /** 실시간인데 일정 시간 갱신이 없음 */
  stale: boolean;
}

export function useBook(symbol: string, depth = 10): BookState {
  return usePolled(
    () => {
      const book = hogaCore.getBook(symbol, depth);
      const stale = book.sync === 'live' && Date.now() - book.lastUpdateMs > STALE_AFTER_MS;
      return {...book, stale};
    },
    b => `${b.subscribed}|${b.seq}|${b.sync}|${b.stale}`,
    BOOK_REFRESH_HZ,
    [symbol, depth],
  );
}

export function useTrades(symbol: string, limit = 20): Trade[] {
  return usePolled(
    () => hogaCore.getTrades(symbol, limit),
    t => (t.length ? `${t.length}|${t[0]!.ts}|${t[0]!.qty}|${t[0]!.price}` : '0'),
    4,
    [symbol, limit],
  );
}

export function useStats(): ClientStats {
  return usePolled(
    () => hogaCore.getStats(),
    s => `${s.state}|${s.attempt}|${s.gaps}|${s.resyncs}|${s.reconnects}|${s.lastError}`,
    2,
    [],
  );
}

/** 연결 상태는 드물게 바뀌므로 C++ 이벤트(EventEmitter)로 받는다. */
export function useConnectionState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(() => hogaCore.getStats().state);
  useEffect(() => {
    const subscription = hogaCore.onConnectionState(setState);
    setState(hogaCore.getStats().state);
    return () => subscription.remove();
  }, []);
  return state;
}
