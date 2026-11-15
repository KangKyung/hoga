import type {CodegenTypes, TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * 기기 보안 신호. 우회가 쉬운 "참고 신호"이며 최종 판단은 서버가 한다.
 * - iOS: Objective-C, Android: Java (레거시 언어 공존 경험을 일부러 남김)
 */
export interface Spec extends TurboModule {
  /** { compromised, reasons: string[], emulator, debugger, captured } */
  getStatus(): CodegenTypes.UnsafeObject;
  /**
   * 민감 화면 보호.
   * Android: FLAG_SECURE(캡처·녹화·최근 앱 미리보기 차단)
   * iOS: 앱 전환기 미리보기를 가림 막으로 덮음(iOS는 캡처 자체를 막을 수 없어 captured로 감지만 한다)
   */
  setSecureScreen(enabled: boolean): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeDeviceGuard');
