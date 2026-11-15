import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * 기기 밖으로 나가면 안 되는 값(리프레시 토큰, 미확정 주문 기록) 저장소.
 * - iOS: Keychain (Objective-C). 생체 보호 시 SecAccessControl(.biometryCurrentSet)
 * - Android: Android Keystore AES-GCM 키로 암호화 (Kotlin). 생체 보호 시 BiometricPrompt + CryptoObject
 * 생체 정보가 바뀌면(지문 추가 등) 보호된 값은 다시 열 수 없게 된다 → 다시 로그인.
 */
export interface Spec extends TurboModule {
  setItem(key: string, value: string, requireBiometrics: boolean, prompt: string): Promise<void>;
  /** 없으면 null. 생체 보호 값이면 인증 창을 띄운다(취소 시 E_CANCELLED) */
  getItem(key: string, prompt: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
  /** 'faceId' | 'touchId' | 'opticId' | 'biometric' | 'none' */
  biometryType(): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeSecureStore');
