import NativeDeviceGuard from '../../specs/NativeDeviceGuard';
import NativeSecureStore from '../../specs/NativeSecureStore';

export type BiometryType = 'faceId' | 'touchId' | 'opticId' | 'biometric' | 'none';

/** 네이티브가 reject할 때 쓰는 코드 */
export type SecureStoreErrorCode =
  | 'E_CANCELLED'
  | 'E_NOT_AVAILABLE'
  | 'E_INVALIDATED'
  | 'E_LOCKOUT'
  | 'E_AUTH_FAILED'
  | 'E_KEYSTORE'
  | 'E_KEYCHAIN';

export function secureStoreErrorCode(e: unknown): SecureStoreErrorCode | undefined {
  const code = (e as {code?: unknown})?.code;
  return typeof code === 'string' ? (code as SecureStoreErrorCode) : undefined;
}

export const secureStore = {
  set: (key: string, value: string, opts: {biometric?: boolean; prompt?: string} = {}) =>
    NativeSecureStore.setItem(key, value, opts.biometric ?? false, opts.prompt ?? ''),
  get: (key: string, prompt = '') => NativeSecureStore.getItem(key, prompt),
  remove: (key: string) => NativeSecureStore.removeItem(key),
  biometryType: async () => (await NativeSecureStore.biometryType()) as BiometryType,
};

export interface DeviceStatus {
  compromised: boolean;
  reasons: string[];
  emulator: boolean;
  debugger: boolean;
  captured: boolean;
}

export const deviceGuard = {
  status: () => NativeDeviceGuard.getStatus() as unknown as DeviceStatus,
  setSecureScreen: (enabled: boolean) => NativeDeviceGuard.setSecureScreen(enabled),
};
