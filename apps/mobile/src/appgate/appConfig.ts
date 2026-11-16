import {AppState, Platform} from 'react-native';
import {useEffect, useState} from 'react';

import {onMaintenance, request} from '../api/http';
import {getLocale} from '../i18n';
import {APP_VERSION} from '../version';

/**
 * 원격 설정(서버 /app/config): 강제 업데이트·업데이트 안내·서비스 점검.
 * 앱 시작, 포그라운드 복귀, 1분마다, 그리고 API가 503 MAINTENANCE를 받으면 다시 읽는다.
 * 읽지 못하면 마지막 값을 유지한다(서버가 꺼졌다고 앱을 막지 않는다 — 점검은 서버가 503으로도 막는다).
 */
export interface AppConfig {
  update: 'none' | 'optional' | 'required';
  minVersion: string;
  latestVersion: string;
  storeUrl: string;
  maintenance: {active: boolean; until: number | null; message: string};
}

export const DEFAULT_CONFIG: AppConfig = {
  update: 'none',
  minVersion: APP_VERSION,
  latestVersion: APP_VERSION,
  storeUrl: '',
  maintenance: {active: false, until: null, message: ''},
};

const REFRESH_MS = 60_000;

/** a < b → -1 (semver 숫자 비교) */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export async function fetchAppConfig(): Promise<AppConfig> {
  const platform = Platform.OS === 'android' ? 'android' : 'ios';
  const {data} = await request<AppConfig>(
    `/app/config?platform=${platform}&version=${APP_VERSION}&lang=${getLocale()}`,
    {timeoutMs: 5000},
  );
  return data;
}

export function useAppConfig(): {config: AppConfig; reload: () => void} {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [tick, setTick] = useState(0);
  const reload = () => setTick(n => n + 1);

  useEffect(() => {
    let alive = true;
    fetchAppConfig()
      .then(c => alive && setConfig(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tick]);

  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS);
    const app = AppState.addEventListener('change', s => s === 'active' && reload());
    const off = onMaintenance(reload);
    return () => {
      clearInterval(timer);
      app.remove();
      off();
    };
  }, []);

  return {config, reload};
}
