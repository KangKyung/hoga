import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

import type { Config } from '../config.js';
import { isLang, LANGS, NOTICES, PROFILES, pick, type Lang, type NoticeCategory } from '../content/content.js';
import type { Market } from '../market/market.js';
import { SYMBOL_PATTERN } from '../protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(here, '..', '..');
const REPO_ROOT = join(SERVER_ROOT, '..');
const WEB_DIR = join(SERVER_ROOT, 'web');
const ADMIN_DIR = join(SERVER_ROOT, 'admin');
const SHARED_DIR = join(REPO_ROOT, 'shared');
const ANGULAR_DIR = dirname(createRequire(import.meta.url).resolve('angular/package.json'));

/**
 * 웹 화면에 거는 보안 헤더.
 * - 스크립트는 같은 출처 + (설정했을 때만) GTM. 인라인 스크립트·eval 금지 → AngularJS는 ng-csp 모드로 돈다.
 * - frame-ancestors 'none': 다른 사이트가 이 화면을 iframe으로 감싸 클릭을 가로채지 못하게.
 */
function contentSecurityPolicy(gtm: boolean): string {
  const gtmScript = gtm ? ' https://www.googletagmanager.com' : '';
  const gtmConnect = gtm ? ' https://www.google-analytics.com https://*.google-analytics.com' : '';
  return [
    "default-src 'self'",
    `script-src 'self'${gtmScript}`,
    "style-src 'self'",
    `img-src 'self' data:${gtm ? ' https://www.googletagmanager.com' : ''}`,
    `connect-src 'self'${gtmConnect}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** 번역 파일(shared/i18n). 파일이 바뀌면 다음 요청에서 다시 읽는다 → 앱 배포 없이 번역 수정 */
class Translations {
  private cache = new Map<Lang, { mtimeMs: number; body: { lang: Lang; version: string; messages: Record<string, string> } }>();

  constructor(private readonly dir: string) {}

  get(lang: Lang) {
    const file = join(this.dir, `${lang}.json`);
    const { mtimeMs } = statSync(file);
    const cached = this.cache.get(lang);
    if (cached && cached.mtimeMs === mtimeMs) return cached.body;
    const raw = readFileSync(file, 'utf8');
    const messages = JSON.parse(raw) as Record<string, string>;
    const version = createHash('sha256').update(raw).digest('hex').slice(0, 12);
    const body = { lang, version, messages };
    this.cache.set(lang, { mtimeMs, body });
    return body;
  }

  available(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  }
}

const langOf = (value: unknown): Lang => (isLang(value) ? value : 'ko');

export function registerWebRoutes(app: FastifyInstance, deps: { market: Market; config: Config }): void {
  const { market, config } = deps;
  const translations = new Translations(join(SHARED_DIR, 'i18n'));
  const csp = contentSecurityPolicy(Boolean(config.GTM_CONTAINER_ID));

  // 웹 화면: HTML은 매번 새로 확인(no-cache)해 서버만 바꿔도 앱에 바로 반영되게 한다.
  const isPage = (url: string) => url.startsWith('/web/') || url.startsWith('/admin/');
  app.addHook('onSend', async (request, reply, payload) => {
    if (isPage(request.url)) {
      reply.header('Content-Security-Policy', csp);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'no-referrer');
      const type = String(reply.getHeader('content-type') ?? '');
      if (type.startsWith('text/html')) reply.header('Cache-Control', 'no-cache');
    }
    return payload;
  });

  app.register(fastifyStatic, { root: WEB_DIR, prefix: '/web/', cacheControl: true, maxAge: 60_000 });
  app.register(fastifyStatic, { root: ADMIN_DIR, prefix: '/admin/', decorateReply: false, maxAge: 0 });
  app.register(fastifyStatic, {
    root: ANGULAR_DIR,
    prefix: '/vendor/angular/',
    decorateReply: false,
    allowedPath: (path) => ['/angular.min.js', '/angular.min.js.map', '/angular-csp.css'].includes(path),
    maxAge: 24 * 60 * 60 * 1000,
    immutable: true,
  });
  app.register(fastifyStatic, {
    root: join(SHARED_DIR, 'analytics'),
    prefix: '/shared/analytics/',
    decorateReply: false,
    maxAge: 0,
  });

  /** 웹 화면 공통 설정(GTM ID 등). 인라인 스크립트를 쓰지 않으려고 JS 파일로 내려 준다 */
  app.get('/web-config.js', async (_request, reply) => {
    const body = { gtmContainerId: config.GTM_CONTAINER_ID ?? null, langs: LANGS };
    return reply
      .type('application/javascript; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .send(`window.HOGA_WEB_CONFIG = Object.freeze(${JSON.stringify(body)});\n`);
  });

  /** 번역. 앱은 version이 내장본과 다를 때만 바꿔 쓴다 */
  app.get('/i18n', async () => ({ langs: translations.available() }));
  app.get<{ Params: { lang: string } }>('/i18n/:lang', async (request, reply) => {
    if (!isLang(request.params.lang)) return reply.code(404).send({ error: 'UNKNOWN_LANG' });
    const body = translations.get(request.params.lang);
    if (request.headers['if-none-match'] === `"${body.version}"`) return reply.code(304).send();
    return reply.header('ETag', `"${body.version}"`).header('Cache-Control', 'no-cache').send(body);
  });

  /** 종목정보 화면용 요약 */
  app.get<{ Params: { symbol: string }; Querystring: { lang?: string } }>(
    '/symbols/:symbol/info',
    async (request, reply) => {
      const { symbol } = request.params;
      if (!SYMBOL_PATTERN.test(symbol) || !market.has(symbol)) {
        return reply.code(404).send({ error: 'UNKNOWN_SYMBOL' });
      }
      const lang = langOf(request.query.lang);
      const info = market.list().find((s) => s.code === symbol)!;
      const profile = PROFILES[symbol];
      return {
        ...info,
        marketCap: info.lastPrice * info.sharesListed,
        day: market.dayStats(symbol) ?? null,
        profile: profile ? pick(profile, lang) : '',
      };
    },
  );

  /** 공지(최신순, 고정 공지 먼저) */
  app.get<{ Querystring: { lang?: string; category?: string } }>('/notices', async (request) => {
    const lang = langOf(request.query.lang);
    const category = request.query.category as NoticeCategory | undefined;
    return NOTICES.filter((n) => !category || n.category === category)
      .toSorted((a, b) => Number(b.pinned) - Number(a.pinned) || b.date.localeCompare(a.date))
      .map((n) => ({ id: n.id, category: n.category, date: n.date, pinned: n.pinned, title: pick(n.title, lang) }));
  });
  app.get<{ Params: { id: string }; Querystring: { lang?: string } }>('/notices/:id', async (request, reply) => {
    const notice = NOTICES.find((n) => n.id === request.params.id);
    if (!notice) return reply.code(404).send({ error: 'NOT_FOUND' });
    const lang = langOf(request.query.lang);
    return { ...notice, title: pick(notice.title, lang), body: pick(notice.body, lang) };
  });
}
