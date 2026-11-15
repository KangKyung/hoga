import {secureStore} from '../native/security';
import {isLocale, setLocale, type Locale} from './index';

/**
 * 고른 언어 저장. 별도 저장소 라이브러리를 들이지 않고 이미 있는 보안 저장소(생체 없음)를 쓴다.
 * 비밀은 아니지만 값이 작고, 기기 밖으로 복제되지 않아도 문제없는 설정이다.
 */
const KEY = 'app.locale';

export async function loadSavedLocale(): Promise<Locale | null> {
  try {
    const saved = await secureStore.get(KEY);
    if (isLocale(saved)) {
      setLocale(saved);
      return saved;
    }
  } catch {
    // 저장소를 못 읽어도 기본 언어로 뜬다
  }
  return null;
}

export function saveLocale(locale: Locale) {
  secureStore.set(KEY, locale).catch(() => {});
}
