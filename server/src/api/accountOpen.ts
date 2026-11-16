import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Ledger } from '../account/ledger.js';
import type { UserStore } from '../auth/users.js';

/**
 * 비대면 계좌 개설(모의). 웹 화면(server/web/account-open)이 단계별로 부르고, 신분증 사진은
 * 네이티브가 직접 올린다(이미지가 웹뷰·브리지를 거치지 않게).
 *
 *   terms → profile → phone → idcard → done
 *
 * - 신청서 ID + 신청 토큰(32바이트, 서버에는 해시만). 앱은 보안 저장소에 두었다가 이어서 진행한다.
 * - 단계 순서를 서버가 강제한다(앞 단계를 건너뛰고 완료할 수 없다).
 * - 30분 동안 움직임이 없으면 신청서를 지운다.
 * - 신분증 이미지는 형식·크기만 확인하고 저장하지 않는다(모의 진위 확인). 해시만 남긴다.
 * - 화면·응답에는 가린 값만(홍*동, 1990-**-**, 010-****-5678).
 * - 휴대폰 인증 코드는 실제로 보내지 않고 개발용으로 응답에 실어 준다(devCode).
 */
export type Step = 'terms' | 'profile' | 'phone' | 'idcard' | 'done';
const ORDER: Step[] = ['terms', 'profile', 'phone', 'idcard', 'done'];

interface Application {
  id: string;
  tokenHash: Buffer;
  step: Step;
  updatedAt: number;
  marketing: boolean;
  profile?: { name: string; birth: string; phone: string; username: string };
  phone?: { code: string; sentAt: number; sends: number; attempts: number };
  idCardHash?: string;
  accountNo?: string;
}

const TTL_MS = 30 * 60 * 1000;
const MAX_SENDS = 5;
const MAX_CODE_ATTEMPTS = 5;
const CODE_TTL_MS = 3 * 60 * 1000;
/** 신분증 JPEG 최대 크기(디코딩 후) */
export const ID_CARD_MAX_BYTES = 1_500_000;

const hash = (token: string) => createHash('sha256').update(token).digest();

export const maskName = (name: string) =>
  name.length <= 1 ? '*' : name.length === 2 ? `${name[0]}*` : `${name[0]}${'*'.repeat(name.length - 2)}${name.at(-1)}`;
export const maskBirth = (birth: string) => `${birth.slice(0, 4)}-**-**`;
export const maskPhone = (phone: string) => `${phone.slice(0, 3)}-****-${phone.slice(-4)}`;

const profileBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(20)
      .regex(/^[가-힣A-Za-z ]+$/),
    birth: z.string().regex(/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/),
    phone: z.string().regex(/^01[016789]\d{7,8}$/),
    username: z.string().regex(/^[a-z][a-z0-9]{3,15}$/),
  })
  .strict();

const completeBody = z
  .object({
    /** 로그인 비밀번호 */
    password: z.string().min(8).max(64),
    /** 계좌 비밀번호 4자리(모의: 저장만 하고 쓰지 않는다) */
    accountPin: z.string().regex(/^\d{4}$/),
  })
  .strict();

function age(birth: string, now: Date): number {
  const y = Number(birth.slice(0, 4));
  const md = Number(birth.slice(4));
  const nowMd = (now.getMonth() + 1) * 100 + now.getDate();
  return now.getFullYear() - y - (nowMd < md ? 1 : 0);
}

/** JPEG 시작(FFD8)·끝(FFD9) 표시 */
function isJpeg(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf.at(-2) === 0xff && buf.at(-1) === 0xd9;
}

export class AccountOpenService {
  private readonly apps = new Map<string, Application>();
  private seq = 100;

  constructor(
    private readonly users: UserStore,
    private readonly ledger: Ledger,
    private readonly now: () => number = Date.now,
  ) {}

  create() {
    this.sweep();
    const token = randomBytes(32).toString('base64url');
    const app: Application = { id: randomUUID(), tokenHash: hash(token), step: 'terms', updatedAt: this.now(), marketing: false };
    this.apps.set(app.id, app);
    return { id: app.id, token, step: app.step };
  }

  /** 신청서 + 토큰 확인. 틀리면 undefined(존재 여부를 구분하지 않는다) */
  find(id: string, token: string | undefined): Application | undefined {
    this.sweep();
    const app = this.apps.get(id);
    if (!app || !token) return undefined;
    const given = hash(token);
    return timingSafeEqual(given, app.tokenHash) ? app : undefined;
  }

  view(app: Application) {
    return {
      id: app.id,
      step: app.step,
      profile: app.profile
        ? {
            name: maskName(app.profile.name),
            birth: maskBirth(app.profile.birth),
            phone: maskPhone(app.profile.phone),
            username: app.profile.username,
          }
        : null,
      idCardVerified: Boolean(app.idCardHash),
      accountNo: app.accountNo ?? null,
    };
  }

  private advance(app: Application, from: Step) {
    app.step = ORDER[ORDER.indexOf(from) + 1]!;
    app.updatedAt = this.now();
  }

  terms(app: Application, body: { required: boolean; privacy: boolean; marketing?: boolean }) {
    if (app.step !== 'terms') return { error: 'WRONG_STEP' } as const;
    if (!body.required || !body.privacy) return { error: 'TERMS_REQUIRED' } as const;
    app.marketing = Boolean(body.marketing);
    this.advance(app, 'terms');
    return this.view(app);
  }

  profile(app: Application, raw: unknown) {
    if (app.step !== 'profile') return { error: 'WRONG_STEP' } as const;
    const parsed = profileBody.safeParse(raw);
    if (!parsed.success) return { error: 'INVALID_PROFILE', field: String(parsed.error.issues[0]?.path[0] ?? '') } as const;
    const p = parsed.data;
    if (age(p.birth, new Date(this.now())) < 19) return { error: 'UNDERAGE' } as const;
    const taken = this.users.has(p.username) || [...this.apps.values()].some((a) => a !== app && a.profile?.username === p.username);
    if (taken) return { error: 'USERNAME_TAKEN' } as const;
    app.profile = p;
    this.advance(app, 'profile');
    return this.view(app);
  }

  sendCode(app: Application) {
    if (app.step !== 'phone') return { error: 'WRONG_STEP' } as const;
    const sends = (app.phone?.sends ?? 0) + 1;
    if (sends > MAX_SENDS) return { error: 'TOO_MANY_SENDS' } as const;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    app.phone = { code, sentAt: this.now(), sends, attempts: 0 };
    app.updatedAt = this.now();
    return { sent: true, to: maskPhone(app.profile!.phone), expiresInSec: CODE_TTL_MS / 1000, devCode: code };
  }

  verifyCode(app: Application, code: string) {
    if (app.step !== 'phone' || !app.phone) return { error: 'WRONG_STEP' } as const;
    if (this.now() - app.phone.sentAt > CODE_TTL_MS) return { error: 'CODE_EXPIRED' } as const;
    if (++app.phone.attempts > MAX_CODE_ATTEMPTS) return { error: 'TOO_MANY_ATTEMPTS' } as const;
    if (code !== app.phone.code) return { error: 'WRONG_CODE', left: MAX_CODE_ATTEMPTS - app.phone.attempts } as const;
    this.advance(app, 'phone');
    return this.view(app);
  }

  idCard(app: Application, base64: string) {
    if (app.step !== 'idcard') return { error: 'WRONG_STEP' } as const;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > ID_CARD_MAX_BYTES) return { error: 'IMAGE_TOO_LARGE' } as const;
    if (!isJpeg(buf)) return { error: 'NOT_JPEG' } as const;
    // 모의 진위 확인: 형식만 본다. 원본은 저장하지 않고 해시만(같은 사진 재사용 추적용)
    app.idCardHash = createHash('sha256').update(buf).digest('hex');
    this.advance(app, 'idcard');
    return { ...this.view(app), bytes: buf.length };
  }

  complete(app: Application, raw: unknown) {
    if (app.step !== 'done' || !app.profile) return { error: 'WRONG_STEP' } as const;
    if (app.accountNo) return { error: 'ALREADY_DONE' } as const;
    const parsed = completeBody.safeParse(raw);
    if (!parsed.success) return { error: 'INVALID_PASSWORD' } as const;
    const userId = `u-${app.profile.username}`;
    const created = this.users.add({ id: userId, username: app.profile.username, name: app.profile.name }, parsed.data.password);
    if (!created) return { error: 'USERNAME_TAKEN' } as const;
    app.accountNo = `5001-20-${String(++this.seq).padStart(6, '0')}`;
    // 모의 입금 1,000만 원(실제 입금 절차 대신)
    this.ledger.open(userId, { accountNo: app.accountNo, cash: 10_000_000 });
    app.updatedAt = this.now();
    return { ...this.view(app), username: app.profile.username };
  }

  private sweep() {
    const cutoff = this.now() - TTL_MS;
    for (const [id, app] of this.apps) if (app.updatedAt < cutoff) this.apps.delete(id);
  }
}

type Req = FastifyRequest<{ Params: { id: string } }>;

export function registerAccountOpenRoutes(app: FastifyInstance, service: AccountOpenService): void {
  const load = (request: Req, reply: FastifyReply) => {
    const token = request.headers['x-application-token'];
    const found = service.find(request.params.id, typeof token === 'string' ? token : undefined);
    if (!found) void reply.code(404).send({ error: 'NOT_FOUND' });
    return found;
  };
  const send = (reply: FastifyReply, result: object) =>
    reply.code('error' in result ? (result.error === 'WRONG_STEP' ? 409 : 422) : 200).send(result);

  app.post('/account-open', async () => service.create());
  app.get<{ Params: { id: string } }>('/account-open/:id', async (request, reply) => {
    const found = load(request, reply);
    return found ? service.view(found) : reply;
  });
  app.post<{ Params: { id: string }; Body: { required?: boolean; privacy?: boolean; marketing?: boolean } }>(
    '/account-open/:id/terms',
    async (request, reply) => {
      const found = load(request, reply);
      if (!found) return reply;
      const b = request.body ?? {};
      return send(reply, service.terms(found, { required: b.required === true, privacy: b.privacy === true, marketing: b.marketing === true }));
    },
  );
  app.post<{ Params: { id: string } }>('/account-open/:id/profile', async (request, reply) => {
    const found = load(request, reply);
    return found ? send(reply, service.profile(found, request.body)) : reply;
  });
  app.post<{ Params: { id: string } }>('/account-open/:id/phone/send', async (request, reply) => {
    const found = load(request, reply);
    return found ? send(reply, service.sendCode(found)) : reply;
  });
  app.post<{ Params: { id: string }; Body: { code?: unknown } }>('/account-open/:id/phone/verify', async (request, reply) => {
    const found = load(request, reply);
    if (!found) return reply;
    const code = typeof request.body?.code === 'string' ? request.body.code : '';
    return send(reply, service.verifyCode(found, code));
  });
  // 이미지 업로드만 본문 제한을 넓힌다(base64 → 약 4/3)
  app.post<{ Params: { id: string }; Body: { image?: unknown } }>(
    '/account-open/:id/id-card',
    { bodyLimit: Math.ceil((ID_CARD_MAX_BYTES * 4) / 3) + 1024 },
    async (request, reply) => {
      const found = load(request, reply);
      if (!found) return reply;
      const image = typeof request.body?.image === 'string' ? request.body.image : '';
      return send(reply, service.idCard(found, image));
    },
  );
  app.post<{ Params: { id: string } }>('/account-open/:id/complete', async (request, reply) => {
    const found = load(request, reply);
    return found ? send(reply, service.complete(found, request.body)) : reply;
  });
}
