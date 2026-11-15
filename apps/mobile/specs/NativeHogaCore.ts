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

  readonly connect: (wsUrl: string, httpBaseUrl: string) => void;
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
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeHogaCore');
