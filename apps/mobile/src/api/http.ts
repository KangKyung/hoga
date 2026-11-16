import {SERVER} from '../config';

/** 응답을 제한 시간 안에 받지 못함. 요청이 서버에 도착했는지는 모른다. */
export class TimeoutError extends Error {
  constructor() {
    super('timeout');
  }
}

/** 연결 자체가 안 됨(서버 꺼짐·네트워크 없음). 요청이 도착했는지는 모른다. */
export class NetworkError extends Error {}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: {error?: string} & Record<string, unknown>,
  ) {
    super(`HTTP ${status} ${body?.error ?? ''}`.trim());
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 로그인한 사용자 토큰을 붙인다 */
  auth?: boolean;
}

/** 액세스 토큰을 주고, 만료되면 갱신해 주는 쪽(SessionManager) */
export interface TokenSource {
  accessToken(): string | null;
  /** 동시에 여러 번 불려도 갱신은 한 번만 한다 */
  refresh(): Promise<string | null>;
}

let tokenSource: TokenSource | null = null;

/** 서버가 점검 중(503 MAINTENANCE)이라고 답했을 때. 앱 게이트가 원격 설정을 다시 읽는다 */
const maintenanceListeners = new Set<() => void>();
export function onMaintenance(listener: () => void): () => void {
  maintenanceListeners.add(listener);
  return () => maintenanceListeners.delete(listener);
}
export function setTokenSource(source: TokenSource | null) {
  tokenSource = source;
}

async function send(path: string, opts: RequestOptions, token: string | null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    return await fetch(`${SERVER.http}${path}`, {
      method: opts.method ?? 'GET',
      signal: controller.signal,
      headers: {
        ...(opts.body !== undefined ? {'content-type': 'application/json'} : {}),
        ...(token ? {authorization: `Bearer ${token}`} : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    if (controller.signal.aborted) throw new TimeoutError();
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * JSON 요청. 2xx면 본문, 아니면 HttpError.
 * 액세스 토큰이 만료(401)면 한 번만 갱신 후 다시 보낸다(같은 Idempotency-Key 헤더 그대로).
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<{status: number; data: T}> {
  let token = opts.auth ? tokenSource?.accessToken() ?? null : null;
  let res = await send(path, opts, token);
  if (res.status === 401 && opts.auth && tokenSource) {
    token = await tokenSource.refresh();
    if (token) res = await send(path, opts, token);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (res.status === 503 && data?.error === 'MAINTENANCE') for (const l of maintenanceListeners) l();
  if (!res.ok && res.status !== 202) throw new HttpError(res.status, data ?? {});
  return {status: res.status, data: data as T};
}
