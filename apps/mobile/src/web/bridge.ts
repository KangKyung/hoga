/**
 * 웹뷰 ↔ 앱 브리지 (앱 쪽 규칙). 웹 쪽 구현: server/web/shared/bridge.js
 *
 * 봉투: {v: 프로토콜 버전, type, payload}
 *
 * 웹이 보낸 메시지는 믿지 않는다. 받는 순서대로 검사한다.
 *   1) 크기: 4KB 초과 거절
 *   2) 출처: 메시지를 보낸 페이지 주소가 허용 출처(우리 서버)인지
 *   3) 속도: 초당 20개 초과 거절(버그·악성 스크립트가 앱을 바쁘게 만들지 못하게)
 *   4) 형식: JSON, 버전, type별 필드 검사
 * 그리고 openOrder는 주문을 내지 않는다. 앱이 주문 창을 열 뿐이고 사용자가 직접 확인해야 주문된다.
 *
 * 계좌 개설(웹 단계 화면) 전용
 *   saveDraft / clearDraft: 신청서 ID·토큰을 앱 보안 저장소에 두었다가 다음에 이어서(웹 저장소는 쓰지 않는다)
 *   captureIdCard: 앱이 카메라·앨범을 열고 사진을 직접 서버에 올린다. 웹에는 결과(idCardResult)만 간다
 *   accountOpened: 끝. 앱이 로그인 화면으로 돌아가 아이디를 채운다
 */
export const BRIDGE_PROTOCOL = 1;
export const MAX_MESSAGE_BYTES = 4 * 1024;

export type WebToApp =
  | {type: 'hello'; payload: {page: string; protocol: number}}
  | {
      type: 'openOrder';
      payload: {symbol: string; side: 'bid' | 'ask'; price?: number};
    }
  | {
      type: 'track';
      payload: {name: string; params: Record<string, unknown>};
    }
  | {type: 'saveDraft'; payload: {id: string; token: string}}
  | {type: 'clearDraft'; payload: Record<string, never>}
  | {type: 'captureIdCard'; payload: Record<string, never>}
  | {type: 'accountOpened'; payload: {username: string}};

export type AppToWeb =
  | {
      type: 'init';
      payload: {
        protocol: number;
        locale: string;
        theme: 'light' | 'dark';
        appVersion: string;
      };
    }
  | {type: 'unsupported'; payload: {protocol: number}}
  | {type: 'quote'; payload: {symbol: string; price: number; ts: number}}
  | {type: 'locale'; payload: {locale: string}}
  | {type: 'draft'; payload: {id: string | null; token: string | null}}
  | {type: 'idCardResult'; payload: {ok: boolean; error?: string; bytes?: number}};

export type RejectReason = 'origin' | 'schema' | 'version' | 'size' | 'rate';
export type ParseResult = {ok: true; message: WebToApp} | {ok: false; reason: RejectReason; type: string};

const SYMBOL = /^\d{6}$/;
const PAGE = /^[a-z_]{1,32}$/;
const EVENT = /^[a-z][a-z0-9_]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APP_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const USERNAME = /^[a-z][a-z0-9]{3,15}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function originOf(url: string): string | null {
  const match = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return match ? match[1]!.toLowerCase() : null;
}

/** 웹뷰가 이 주소로 가도 되는가(허용 출처 목록) */
export function isAllowedUrl(url: string, allowedOrigins: readonly string[]): boolean {
  if (url === 'about:blank') return true;
  const origin = originOf(url);
  return origin !== null && allowedOrigins.map(o => o.toLowerCase()).includes(origin);
}

function validatePayload(type: string, payload: unknown): WebToApp | null {
  if (!isObject(payload)) return null;
  switch (type) {
    case 'hello':
      if (typeof payload.page !== 'string' || !PAGE.test(payload.page)) return null;
      if (typeof payload.protocol !== 'number' || !Number.isInteger(payload.protocol)) return null;
      return {
        type,
        payload: {page: payload.page, protocol: payload.protocol},
      };
    case 'openOrder': {
      const {symbol, side, price} = payload;
      if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) return null;
      if (side !== 'bid' && side !== 'ask') return null;
      if (price !== undefined && price !== null && (typeof price !== 'number' || !Number.isSafeInteger(price) || price <= 0)) {
        return null;
      }
      return {
        type,
        payload: {
          symbol,
          side,
          price: typeof price === 'number' ? price : undefined,
        },
      };
    }
    case 'track':
      if (typeof payload.name !== 'string' || !EVENT.test(payload.name)) return null;
      if (payload.params !== undefined && !isObject(payload.params)) return null;
      return {
        type,
        payload: {
          name: payload.name,
          params: (payload.params as Record<string, unknown>) ?? {},
        },
      };
    case 'saveDraft':
      if (typeof payload.id !== 'string' || !UUID.test(payload.id)) return null;
      if (typeof payload.token !== 'string' || !APP_TOKEN.test(payload.token)) return null;
      return {type, payload: {id: payload.id, token: payload.token}};
    case 'clearDraft':
    case 'captureIdCard':
      return {type, payload: {}};
    case 'accountOpened':
      if (typeof payload.username !== 'string' || !USERNAME.test(payload.username)) return null;
      return {type, payload: {username: payload.username}};
    default:
      return null;
  }
}

export function parseWebMessage(raw: string, sourceUrl: string, allowedOrigins: readonly string[]): ParseResult {
  if (raw.length > MAX_MESSAGE_BYTES) return {ok: false, reason: 'size', type: 'unknown'};
  if (!isAllowedUrl(sourceUrl, allowedOrigins) || sourceUrl === 'about:blank') {
    return {ok: false, reason: 'origin', type: 'unknown'};
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return {ok: false, reason: 'schema', type: 'unknown'};
  }
  if (!isObject(envelope) || typeof envelope.type !== 'string') return {ok: false, reason: 'schema', type: 'unknown'};
  const type = envelope.type.slice(0, 32);
  if (envelope.v !== BRIDGE_PROTOCOL) return {ok: false, reason: 'version', type};
  const message = validatePayload(type, envelope.payload);
  return message ? {ok: true, message} : {ok: false, reason: 'schema', type};
}

/** injectJavaScript에 넣을 코드. 값은 JSON으로 두 번 감싸 문자열 밖으로 새지 않게 한다 */
export function toWebScript(message: AppToWeb): string {
  const envelope = JSON.stringify({v: BRIDGE_PROTOCOL, ...message});
  return `window.HogaBridge && window.HogaBridge.receive(${JSON.stringify(envelope)}); true;`;
}

/** 초당 메시지 수 제한(토큰 버킷) */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(private readonly perSecond = 20, private readonly now: () => number = Date.now) {
    this.tokens = perSecond;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.perSecond, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
