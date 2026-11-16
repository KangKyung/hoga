import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AuthError, type AuthService } from '../auth/auth.js';
import { JwtError } from '../auth/jwt.js';
import { rateLimitKey } from '../util/ip.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }).strict();
const refreshBody = z.object({ refreshToken: z.string().min(20).max(512) }).strict();

const STATUS: Record<AuthError['code'], number> = {
  INVALID_CREDENTIALS: 401,
  TOO_MANY_ATTEMPTS: 429,
  INVALID_REFRESH: 401,
  REFRESH_REUSED: 401,
};

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  app.post('/auth/login', async (request, reply) => {
    const body = loginBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST' });
    try {
      return await auth.login(body.data.username, body.data.password, rateLimitKey(request.ip));
    } catch (err) {
      if (err instanceof AuthError) return reply.code(STATUS[err.code]).send({ error: err.code });
      throw err;
    }
  });

  /** 리프레시 토큰 회전: 쓸 때마다 새 토큰을 주고 이전 것은 다시 못 쓴다 */
  app.post('/auth/refresh', async (request, reply) => {
    const body = refreshBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST' });
    try {
      return await auth.rotate(body.data.refreshToken);
    } catch (err) {
      if (err instanceof AuthError) return reply.code(STATUS[err.code]).send({ error: err.code });
      throw err;
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const body = refreshBody.safeParse(request.body);
    if (body.success) await auth.logout(body.data.refreshToken);
    return reply.code(204).send();
  });
}

/** Authorization: Bearer <액세스 토큰> 확인. 실패하면 401로 끝낸다 */
export function requireUser(auth: AuthService) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    try {
      request.userId = auth.verify(token).sub;
    } catch (err) {
      const code = err instanceof JwtError && err.code === 'EXPIRED' ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED';
      return reply.code(401).send({ error: code });
    }
  };
}
