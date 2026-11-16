/**
 * 주문 2단계 인증(OTP) 클라이언트.
 * - 서버가 주문에 403 OTP_REQUIRED를 주면 주문 창이 코드를 받아 verify → 단기 step-up 토큰(10분)을 받는다
 * - step-up 토큰은 메모리에만 둔다(앱을 다시 켜면 다시 입력). 로그아웃하면 지운다
 * - 시드(비밀)는 등록할 때 한 번만 화면에 보여 주고 앱에 저장하지 않는다(인증 앱에 넣는 값)
 */
import {HttpError, request} from '../api/http';

let stepUp: {token: string; expiresAt: number} | null = null;

export function stepUpToken(now = Date.now()): string | null {
  return stepUp && stepUp.expiresAt > now ? stepUp.token : null;
}

export function clearStepUp() {
  stepUp = null;
}

export type OtpErrorCode =
  | 'OTP_INVALID'
  | 'OTP_LOCKED'
  | 'OTP_NOT_ENABLED'
  | 'OTP_ALREADY_ENABLED'
  | 'OTP_NOT_ENROLLED'
  | 'NETWORK';

function errorCode(e: unknown): OtpErrorCode {
  if (e instanceof HttpError) return (e.body.error as OtpErrorCode) ?? 'NETWORK';
  return 'NETWORK';
}

async function call<T>(path: string, body?: unknown): Promise<{ok: true; data: T} | {ok: false; error: OtpErrorCode}> {
  try {
    const {data} = await request<T>(`/auth/otp${path}`, {
      method: body === undefined && path === '' ? 'GET' : 'POST',
      auth: true,
      body,
    });
    return {ok: true, data};
  } catch (e) {
    return {ok: false, error: errorCode(e)};
  }
}

export const otp = {
  status: () => call<{enabled: boolean}>(''),
  enroll: () => call<{secret: string; otpauthUrl: string}>('/enroll', {}),
  confirm: (code: string) => call<{enabled: true}>('/confirm', {code}),
  disable: (code: string) => call<{enabled: false}>('/disable', {code}),
  /** 맞으면 step-up 토큰을 기억해 두고 true */
  async verify(code: string, now = Date.now()) {
    const r = await call<{stepUpToken: string; expiresIn: number}>('/verify', {code});
    if (r.ok) stepUp = {token: r.data.stepUpToken, expiresAt: now + r.data.expiresIn * 1000 - 5_000};
    return r;
  },
};
