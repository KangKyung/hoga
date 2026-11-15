import {useSyncExternalStore} from 'react';

import en from '../../../../shared/i18n/en.json';
import id from '../../../../shared/i18n/id.json';
import ko from '../../../../shared/i18n/ko.json';
import th from '../../../../shared/i18n/th.json';

/**
 * 현지화(ko · en · id · th).
 *
 * - 번역 파일은 저장소의 shared/i18n 한 벌을 앱(번들)과 웹 화면(서버 /i18n/:lang)이 함께 쓴다.
 * - 앱은 내장 번역으로 바로 뜨고, 서버에 다른 버전이 있으면 받아서 덮어쓴다 → 문구 수정에 앱 배포가 필요 없다.
 *   서버 번역에 빠진 키는 내장본, 그다음 ko로 대신한다(빈 화면 대신 한국어라도 보이게).
 * - 숫자는 Intl.NumberFormat(언어)로 쓴다. 같은 71200도 ko·en·th는 71,200, id는 71.200.
 */
export const LOCALES = ['ko', 'en', 'id', 'th'] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageKey = keyof typeof ko;
type Messages = Record<string, string>;

export const LOCALE_NAMES: Record<Locale, string> = {
  ko: '한국어',
  en: 'English',
  id: 'Bahasa Indonesia',
  th: 'ไทย',
};

const BUNDLED: Record<Locale, Messages> = {ko, en, id, th};

export const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

interface State {
  locale: Locale;
  messages: Messages;
  /** 서버 번역을 쓰는 중이면 그 버전, 아니면 null(내장) */
  remoteVersion: string | null;
}

let state: State = {locale: 'ko', messages: BUNDLED.ko, remoteVersion: null};
const listeners = new Set<() => void>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function set(next: State) {
  state = next;
  listeners.forEach(l => l());
}

export function getLocale(): Locale {
  return state.locale;
}

export function getI18nState(): State {
  return state;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function t(key: MessageKey | (string & {}), params?: Record<string, string | number>): string {
  const text = state.messages[key] ?? BUNDLED[state.locale][key] ?? BUNDLED.ko[key] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (params[name] !== undefined ? String(params[name]) : all));
}

export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  const cacheKey = `${state.locale}|${options ? JSON.stringify(options) : ''}`;
  let format = numberFormats.get(cacheKey);
  if (!format) {
    format = new Intl.NumberFormat(state.locale, options);
    numberFormats.set(cacheKey, format);
  }
  return format.format(n);
}

export function setLocale(locale: Locale) {
  if (locale === state.locale) return;
  set({locale, messages: BUNDLED[locale], remoteVersion: null});
}

/**
 * 서버의 번역을 받아 쓴다. fetcher는 테스트에서 바꿔 끼운다.
 * 실패하면 내장 번역을 그대로 쓴다(네트워크가 없어도 앱은 떠야 한다).
 */
export async function refreshFromServer(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<'updated' | 'unchanged' | 'failed'> {
  const locale = state.locale;
  try {
    const headers: Record<string, string> = {};
    if (state.remoteVersion) headers['If-None-Match'] = `"${state.remoteVersion}"`;
    const response = await fetcher(`${baseUrl}/i18n/${locale}`, {headers});
    if (response.status === 304) return 'unchanged';
    if (!response.ok) return 'failed';
    const body = (await response.json()) as {
      lang?: string;
      version?: string;
      messages?: Messages;
    };
    if (body.lang !== locale || typeof body.version !== 'string' || !body.messages) return 'failed';
    if (state.locale !== locale) return 'unchanged'; // 받는 사이 언어가 바뀜
    const messages: Messages = {...BUNDLED[locale]};
    for (const [key, value] of Object.entries(body.messages)) {
      if (typeof value === 'string') messages[key] = value;
    }
    set({locale, messages, remoteVersion: body.version});
    return 'updated';
  } catch {
    return 'failed';
  }
}

/** 언어가 바뀌면 다시 그려지도록 구독하고 t·숫자 형식을 돌려준다 */
export function useI18n() {
  const current = useSyncExternalStore(subscribe, getI18nState);
  return {
    locale: current.locale,
    remoteVersion: current.remoteVersion,
    t,
    formatNumber,
  };
}

/** 테스트용 초기화 */
export function resetI18nForTest() {
  numberFormats.clear();
  set({locale: 'ko', messages: BUNDLED.ko, remoteVersion: null});
}
