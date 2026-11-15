import taxonomy from '../../../../shared/analytics/events.json';

/**
 * 분석 이벤트.
 *
 * 이벤트 이름·매개변수는 shared/analytics/events.json 한 벌을 앱과 웹이 함께 쓴다(문서: docs/analytics-taxonomy.md).
 * 실제 전송(Firebase Analytics 등)은 AnalyticsSink로 꽂는다. 이 저장소는 외부 계정 없이 돌아가도록
 * 메모리에 최근 이벤트를 모아 설정 화면에서 보여 주는 디버그 싱크만 기본으로 켠다.
 *
 * 규칙
 * - 개인정보·금액·수량은 보내지 않는다(분류표에 정의된 매개변수만).
 * - 분류표에 없는 이벤트·매개변수는 개발 중 경고. 운영에서는 매개변수를 걸러 보낸다.
 * - 웹뷰에서 온 이벤트는 source=web으로 같은 파이프라인 하나로 보낸다(웹 GTM과 이중 집계하지 않음).
 */
type ParamValue = string | number | boolean;
export type AnalyticsParams = Record<string, ParamValue>;
export type EventSource = 'app' | 'web';

interface EventSpec {
  source: EventSource[];
  params: Record<string, string>;
  description: string;
}

const EVENTS = taxonomy.events as Record<string, EventSpec>;
export type EventName = keyof typeof taxonomy.events;

export interface AnalyticsEvent {
  name: string;
  params: AnalyticsParams;
  source: EventSource;
  ts: number;
}

export interface AnalyticsSink {
  log(event: AnalyticsEvent): void;
}

export const TAXONOMY_VERSION = taxonomy.version;

/** 분류표 검사. 문제가 없으면 빈 배열 */
export function validateEvent(name: string, params: AnalyticsParams, source: EventSource): string[] {
  const spec = EVENTS[name];
  if (!spec) return [`unknown event: ${name}`];
  const problems: string[] = [];
  if (!spec.source.includes(source)) problems.push(`${name} is not sent from ${source}`);
  for (const [key, value] of Object.entries(params)) {
    if (!(key in spec.params)) problems.push(`${name}: unknown param ${key}`);
    if (typeof value === 'string' && value.length > 100) problems.push(`${name}: ${key} longer than 100`);
  }
  return problems;
}

/** 분류표에 정의된 매개변수만 남긴다(웹에서 온 값처럼 믿을 수 없는 입력용) */
function sanitize(name: string, params: AnalyticsParams): AnalyticsParams {
  const spec = EVENTS[name];
  if (!spec) return {};
  const out: AnalyticsParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (!(key in spec.params)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 100);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** 최근 이벤트를 메모리에 모아 두는 싱크(설정 화면의 디버그 목록) */
export class MemorySink implements AnalyticsSink {
  private events: AnalyticsEvent[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly capacity = 30) {}

  log(event: AnalyticsEvent) {
    this.events = [event, ...this.events].slice(0, this.capacity);
    this.listeners.forEach(l => l());
  }

  recent = () => this.events;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export const debugSink = new MemorySink();
let sinks: AnalyticsSink[] = [debugSink];
const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

/** Firebase 등 실제 싱크를 꽂을 때 */
export function setSinks(next: AnalyticsSink[]) {
  sinks = next;
}

export function track(name: EventName, params: AnalyticsParams = {}) {
  emit(name, params, 'app');
}

/** 웹뷰가 보낸 이벤트: 분류표에 있는 web 이벤트만 받고 매개변수를 거른다 */
export function trackFromWeb(name: string, params: unknown): boolean {
  const spec = EVENTS[name];
  if (!spec || !spec.source.includes('web')) return false;
  const raw = params && typeof params === 'object' ? (params as AnalyticsParams) : {};
  emit(name, sanitize(name, raw), 'web');
  return true;
}

function emit(name: string, params: AnalyticsParams, source: EventSource) {
  if (isDev) {
    const problems = validateEvent(name, params, source);
    if (problems.length) console.warn('[analytics]', problems.join('; '));
  }
  const event: AnalyticsEvent = {
    name,
    params: sanitize(name, params),
    source,
    ts: Date.now(),
  };
  for (const sink of sinks) {
    try {
      sink.log(event);
    } catch {
      // 분석 실패가 화면 동작을 막으면 안 된다
    }
  }
}
