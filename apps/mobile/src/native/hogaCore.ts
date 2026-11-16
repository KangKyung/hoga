/**
 * NativeHogaCore(C++ TurboModule)를 타입이 있는 API로 감싼다.
 * Codegen 스펙은 객체를 UnsafeObject로만 표현하므로, 실제 모양은 여기서 정의한다.
 */
import NativeHogaCore from '../../specs/NativeHogaCore';

/** [가격, 잔량] */
export type Level = [number, number];
export type SyncState = 'waiting' | 'live' | 'resyncing';
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped';

/** 서버 status: 장 구간·매매 방식·VI·단일가 예상 체결(C++ MarketClient가 보관). phase가 ''이면 아직 모름 */
export interface SessionView {
  phase: '' | 'PRE_OPEN' | 'OPEN' | 'CLOSING' | 'CLOSED';
  mode: '' | 'CONTINUOUS' | 'AUCTION' | 'HALTED';
  viKind: '' | 'STATIC' | 'DYNAMIC';
  viUntil: number;
  viRef: number;
  expPrice: number;
  expQty: number;
}

export const EMPTY_SESSION: SessionView = {phase: '', mode: '', viKind: '', viUntil: 0, viRef: 0, expPrice: 0, expQty: 0};

export interface BookView {
  subscribed: boolean;
  seq: number;
  sync: SyncState;
  /** 매수: 높은 가격부터 */
  bids: Level[];
  /** 매도: 낮은 가격부터 */
  asks: Level[];
  lastUpdateMs: number;
  session: SessionView;
}

export interface Trade {
  price: number;
  qty: number;
  /** none = 단일가 체결(주도한 쪽 없음) */
  aggressor: 'bid' | 'ask' | 'none';
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

const EMPTY_BOOK: BookView = {
  subscribed: false,
  seq: 0,
  sync: 'waiting',
  bids: [],
  asks: [],
  lastUpdateMs: 0,
  session: EMPTY_SESSION,
};

export const hogaCore = {
  coreVersion: () => NativeHogaCore.coreVersion(),
  tickSize: (price: number) => NativeHogaCore.tickSize(price),
  roundToTick: (price: number, mode: 'up' | 'down') => NativeHogaCore.roundToTick(price, mode),
  priceLimits: (basePrice: number) => NativeHogaCore.priceLimits(basePrice) as unknown as {lower: number; upper: number},
  /** 'NONE'이면 통과. 서버와 같은 C++ 규칙 */
  validateOrder: (side: 'bid' | 'ask', type: 'limit' | 'market', price: number, qty: number, basePrice: number) =>
    NativeHogaCore.validateOrder(side, type, price, qty, basePrice),
  /** 서버가 준 한도로 계좌 검증(같은 C++ checkAccount). 'NONE'이면 통과 */
  checkAccount: (
    side: 'bid' | 'ask',
    type: 'limit' | 'market',
    price: number,
    qty: number,
    limits: {availableCash: number; sellableQty: number},
    upperLimit: number,
  ) => NativeHogaCore.checkAccount(side, type, price, qty, limits.availableCash, limits.sellableQty, upperLimit),
  randomId: () => NativeHogaCore.randomId(),
  setAuthToken: (token: string) => NativeHogaCore.setAuthToken(token),

  connect: (wsUrl: string, httpBaseUrl: string) => NativeHogaCore.connect(wsUrl, httpBaseUrl),
  disconnect: () => NativeHogaCore.disconnect(),
  subscribe: (symbols: string[]) => NativeHogaCore.subscribe(symbols),
  unsubscribe: (symbols: string[]) => NativeHogaCore.unsubscribe(symbols),

  getBook(symbol: string, depth: number): BookView {
    const raw = NativeHogaCore.getBook(symbol, depth) as Partial<BookView>;
    if (!raw.subscribed) return EMPTY_BOOK;
    return {...(raw as BookView), session: raw.session ?? EMPTY_SESSION};
  },
  getTrades: (symbol: string, limit: number) => NativeHogaCore.getTrades(symbol, limit) as unknown as Trade[],
  getStats: () => NativeHogaCore.getStats() as unknown as ClientStats,

  onConnectionState: (listener: (state: ConnectionState) => void) =>
    NativeHogaCore.onConnectionState(state => listener(state as ConnectionState)),
  /** 비교 실험 전용: 켜면 시세 메시지 원문을 매번 JS로 보낸다("JS 경유" 버전) */
  setMarketTap: (enabled: boolean) => NativeHogaCore.setMarketTap(enabled),
  onMarketMessage: (listener: (json: string) => void) => NativeHogaCore.onMarketMessage(listener),
  /** 내 주문 변화(서버 order 메시지) */
  onOrderEvent: (listener: (event: OrderEvent) => void) =>
    NativeHogaCore.onOrderEvent(json => {
      const event = parseUserEvent(json);
      if (event?.t === 'order') listener(event as OrderEvent);
    }),
  /** 서버가 WS 인증을 거절함(액세스 토큰 만료 등) → 토큰을 갱신하면 C++가 새 토큰으로 다시 인증한다 */
  onAuthRejected: (listener: () => void) =>
    NativeHogaCore.onOrderEvent(json => {
      const event = parseUserEvent(json);
      if (event?.t === 'error' && event.code === 'UNAUTHORIZED') listener();
    }),
};

/** 사용자 전용 메시지(주문 알림·인증 거절). 형식이 틀리면 무시(다음 목록 조회로 맞춰진다) */
function parseUserEvent(json: string): {t?: string; code?: string} | null {
  try {
    return JSON.parse(json) as {t?: string; code?: string};
  } catch {
    return null;
  }
}

export interface OrderEvent {
  t: 'order';
  key: string;
  orderId: number;
  symbol: string;
  side: 'bid' | 'ask';
  type: 'limit' | 'market';
  price: number;
  qty: number;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  filled: number;
  resting: number;
  amendOf?: string;
  amended?: number;
  fill?: {price: number; qty: number};
  ts: number;
}
