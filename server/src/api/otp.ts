import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AuthService } from '../auth/auth.js';
import { OtpError, type OtpService } from '../auth/otp.js';
import { requireUser } from './auth.js';

const codeBody = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

const STATUS: Record<OtpError['code'], number> = {
  OTP_NOT_ENROLLED: 409,
  OTP_ALREADY_ENABLED: 409,
  OTP_INVALID: 401,
  OTP_LOCKED: 429,
  OTP_NOT_ENABLED: 409,
};

/** /auth/otp: 상태 · 등록 · 확인 · 주문 전 인증(step-up) · 해제 */
export function registerOtpRoutes(app: FastifyInstance, auth: AuthService, otp: OtpService): void {
  app.register(
    async (scope) => {
      scope.addHook('preHandler', requireUser(auth));
      const handle = async <T>(reply: { code(n: number): { send(b: unknown): unknown } }, fn: () => Promise<T>) => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof OtpError) return reply.code(STATUS[err.code]).send({ error: err.code });
          throw err;
        }
      };

      scope.get('/', async (request) => otp.status(request.userId!));
      scope.post('/enroll', async (request, reply) => handle(reply, () => otp.enroll(request.userId!, request.userId!)));
      const actions: Array<[string, (id: string, code: string) => Promise<object>]> = [
        ['/confirm', (id, code) => otp.confirm(id, code)],
        ['/verify', (id, code) => otp.verify(id, code)],
        ['/disable', async (id, code) => (await otp.disable(id, code), { enabled: false })],
      ];
      for (const [path, action] of actions) {
        scope.post(path, async (request, reply) => {
          const body = codeBody.safeParse(request.body);
          if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST' });
          return handle(reply, () => action(request.userId!, body.data.code));
        });
      }
    },
    { prefix: '/auth/otp' },
  );
}
