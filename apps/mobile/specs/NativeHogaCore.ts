import type {CodegenTypes, TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * hoga-core(C++) 공용 TurboModule.
 * 구현은 iOS·Android가 함께 쓰는 C++ 한 벌(bindings/turbomodule)이다.
 *
 * 시세 원칙: 고빈도 데이터는 JS로 밀어 넣지 않는다.
 * 소켓 → C++ MarketClient가 호가를 유지하고, JS는 필요할 때(초당 10~15회) getBook으로 끌어온다.
 * 이벤트는 연결 상태처럼 드물게 바뀌는 것만 보낸다.
 *
 * Object 반환값의 실제 모양은 src/native/hogaCore.ts의 타입을 따른다.
 */
export interface Spec extends TurboModule {
  /** C++ 코어 버전. 서버(N-API)와 같은 값이어야 한다. */
  readonly coreVersion: () => string;
  /** 국내 주식 호가가격단위(원). 정수가 아니면 JS 오류를 던진다. */
  readonly tickSize: (price: number) => number;
  /** 'up' | 'down' */
  readonly roundToTick: (price: number, mode: string) => number;
  /** 상·하한가 { lower, upper } */
  readonly priceLimits: (basePrice: number) => CodegenTypes.UnsafeObject;
  /** 서버와 같은 C++ 규칙으로 주문 검증. 'NONE'이면 통과, 아니면 'OFF_TICK' 같은 거부 사유 */
  readonly validateOrder: (side: string, type: string, price: number, qty: number, basePrice: number) => string;
  /** 주문 멱등 키용 UUID v4 (C++ std::random_device) */
  readonly randomId: () => string;

  readonly connect: (wsUrl: string, httpBaseUrl: string) => void;
  /** 로그인 후 액세스 토큰. 연결될 때마다 서버에 인증해 내 주문 알림을 받는다. 빈 문자열이면 해제 */
  readonly setAuthToken: (token: string) => void;
  readonly disconnect: () => void;
  readonly subscribe: (symbols: ReadonlyArray<string>) => void;
  readonly unsubscribe: (symbols: ReadonlyArray<string>) => void;

  /** 동기 호출(JSI). { subscribed, seq, sync, bids:[[px,qty]], asks, lastUpdateMs } */
  readonly getBook: (symbol: string, depth: number) => CodegenTypes.UnsafeObject;
  /** 최근 체결, 최신이 앞. [{ price, qty, aggressor, ts }] */
  readonly getTrades: (symbol: string, limit: number) => ReadonlyArray<CodegenTypes.UnsafeObject>;
  /** { state, attempt, messages, gaps, resyncs, reconnects, parseErrors, lastError } */
  readonly getStats: () => CodegenTypes.UnsafeObject;

  /** 연결 상태 변경: 'connecting' | 'open' | 'reconnecting' | 'stopped' */
  readonly onConnectionState: CodegenTypes.EventEmitter<string>;
  /** 내 주문 상태 변화(JSON 문자열). 빈도가 낮아 push로 받는다 */
  readonly onOrderEvent: CodegenTypes.EventEmitter<string>;

  /**
   * 비교 실험 전용("JS 경유" 버전): 켜면 시세 메시지(snap·delta·trade) 원문을 매번 JS로 보낸다.
   * 앱 기본 경로는 끈 상태(C++ 직접 + JSI pull)다.
   */
  readonly setMarketTap: (enabled: boolean) => void;
  readonly onMarketMessage: CodegenTypes.EventEmitter<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeHogaCore');
