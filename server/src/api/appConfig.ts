import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Lang } from '../content/content.js';

/**
 * 앱 원격 설정: 강제 업데이트·최신 버전 안내·서비스 점검.
 *
 * - 최소 버전보다 낮으면 앱은 업데이트 화면만 보여 준다(주문 불가). 보안 수정·프로토콜 변경을 배포할 때 쓴다.
 * - 최신 버전보다 낮으면 닫을 수 있는 안내만.
 * - 점검 중이면 앱은 점검 화면을 보여 주고, 서버는 주문·계좌·로그인 API를 503 MAINTENANCE로 막는다
 *   (앱이 설정을 늦게 받아도 서버가 막는다). 원격 설정·관리·헬스 체크·웹 화면은 그대로.
 */
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

export const appConfigUpdate = z
  .object({
    minVersion: semver.optional(),
    latestVersion: semver.optional(),
    maintenance: z
      .object({
        active: z.boolean(),
        /** 종료 예정 시각(epoch ms). 모르면 null */
        until: z.number().int().positive().nullable().optional(),
        message: z.string().max(300).optional(),
      })
      .optional(),
  })
  .strict();

export interface AppConfigState {
  minVersion: string;
  latestVersion: string;
  storeUrl: { ios: string; android: string };
  maintenance: { active: boolean; until: number | null; message: string };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const DEFAULT_MESSAGE: Record<Lang, string> = {
  ko: '더 안정적인 서비스를 위해 시스템 점검 중입니다.',
  en: 'We are performing scheduled maintenance.',
  id: 'Sedang dilakukan pemeliharaan sistem.',
  th: 'ระบบอยู่ระหว่างการปรับปรุง',
};

/** 점검 중에 막는 API(앞부분 일치) */
const BLOCKED_PREFIXES = ['/orders', '/account', '/auth/', '/otp/'];

export class AppConfigStore {
  state: AppConfigState;

  constructor(initial: Partial<AppConfigState> = {}) {
    this.state = {
      minVersion: '0.1.0',
      latestVersion: '0.8.0',
      // 모의 스토어 주소(실제 앱 없음)
      storeUrl: { ios: 'https://apps.apple.com/', android: 'https://play.google.com/store' },
      maintenance: { active: false, until: null, message: '' },
      ...initial,
    };
  }

  update(change: z.infer<typeof appConfigUpdate>): AppConfigState {
    if (change.minVersion) this.state.minVersion = change.minVersion;
    if (change.latestVersion) this.state.latestVersion = change.latestVersion;
    if (compareVersions(this.state.latestVersion, this.state.minVersion) < 0) {
      this.state.latestVersion = this.state.minVersion;
    }
    if (change.maintenance) {
      this.state.maintenance = {
        active: change.maintenance.active,
        until: change.maintenance.until ?? null,
        message: change.maintenance.message ?? '',
      };
    }
    return this.state;
  }

  blocks(url: string): boolean {
    return this.state.maintenance.active && BLOCKED_PREFIXES.some((p) => url.startsWith(p));
  }

  /** 앱이 받는 모양: 이 앱 버전에 무엇을 해야 하는지까지 계산해서 준다 */
  forApp(platform: 'ios' | 'android', version: string, lang: Lang) {
    const { minVersion, latestVersion, maintenance, storeUrl } = this.state;
    const update =
      compareVersions(version, minVersion) < 0 ? 'required' : compareVersions(version, latestVersion) < 0 ? 'optional' : 'none';
    return {
      update,
      minVersion,
      latestVersion,
      storeUrl: storeUrl[platform],
      maintenance: {
        active: maintenance.active,
        until: maintenance.until,
        message: maintenance.message || DEFAULT_MESSAGE[lang],
      },
    };
  }
}

export function registerAppConfigRoutes(app: FastifyInstance, store: AppConfigStore): void {
  app.addHook('onRequest', async (request, reply) => {
    if (store.blocks(request.url)) {
      return reply.code(503).send({ error: 'MAINTENANCE', until: store.state.maintenance.until });
    }
  });

  app.get<{ Querystring: { platform?: string; version?: string; lang?: string } }>('/app/config', async (request, reply) => {
    const { platform, version = '', lang = 'ko' } = request.query;
    if ((platform !== 'ios' && platform !== 'android') || !semver.safeParse(version).success) {
      return reply.code(400).send({ error: 'BAD_REQUEST' });
    }
    const l = (['ko', 'en', 'id', 'th'] as const).includes(lang as Lang) ? (lang as Lang) : 'ko';
    return reply.header('Cache-Control', 'no-cache').send(store.forApp(platform, version, l));
  });
}
