import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * hoga-core(C++) 공용 TurboModule.
 * 구현은 iOS·Android가 함께 쓰는 C++ 한 벌(bindings/turbomodule)이다.
 */
export interface Spec extends TurboModule {
  /** C++ 코어 버전. 서버(N-API)와 같은 값이어야 한다. */
  readonly coreVersion: () => string;
  /** 국내 주식 호가가격단위(원). 정수가 아니면 JS 오류를 던진다. */
  readonly tickSize: (price: number) => number;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeHogaCore');
