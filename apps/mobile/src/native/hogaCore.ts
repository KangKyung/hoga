/**
 * NativeHogaCore(C++ TurboModule)를 타입이 있는 API로 감싼다.
 * Codegen 스펙은 객체를 UnsafeObject로만 표현하므로, 실제 모양은 여기서 정의한다.
 */
import NativeHogaCore from '../../specs/NativeHogaCore';

/** [가격, 잔량] */
export type Level = [number, number];
export type SyncState = 'waiting' | 'live' | 'resyncing';
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface BookView {
  subscribed: boolean;
  seq: number;
  sync: SyncState;
  /** 매수: 높은 가격부터 */
  bids: Level[];
  /** 매도: 낮은 가격부터 */
  asks: Level[];
  lastUpdateMs: number;
}

export interface Trade {
  price: number;
  qty: number;
  aggressor: 'bid' | 'ask';
  ts: number;
}

export interface ClientStats {
  state: ConnectionState;
  attempt: number;
  messages: number;
  gaps: number;
  resyncs: number;
  reconnects: number;
  parseErrors: number;
  lastError: string;
}

const EMPTY_BOOK: BookView = {subscribed: false, seq: 0, sync: 'waiting', bids: [], asks: [], lastUpdateMs: 0};

export const hogaCore = {
  coreVersion: () => NativeHogaCore.coreVersion(),
  tickSize: (price: number) => NativeHogaCore.tickSize(price),
  roundToTick: (price: number, mode: 'up' | 'down') => NativeHogaCore.roundToTick(price, mode),

  connect: (wsUrl: string, httpBaseUrl: string) => NativeHogaCore.connect(wsUrl, httpBaseUrl),
  disconnect: () => NativeHogaCore.disconnect(),
  subscribe: (symbols: string[]) => NativeHogaCore.subscribe(symbols),
  unsubscribe: (symbols: string[]) => NativeHogaCore.unsubscribe(symbols),

  getBook(symbol: string, depth: number): BookView {
    const raw = NativeHogaCore.getBook(symbol, depth) as Partial<BookView>;
    return raw.subscribed ? (raw as BookView) : EMPTY_BOOK;
  },
  getTrades: (symbol: string, limit: number) => NativeHogaCore.getTrades(symbol, limit) as unknown as Trade[],
  getStats: () => NativeHogaCore.getStats() as unknown as ClientStats,

  onConnectionState: (listener: (state: ConnectionState) => void) =>
    NativeHogaCore.onConnectionState(state => listener(state as ConnectionState)),
};
