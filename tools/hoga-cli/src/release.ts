/**
 * 릴리스 한 번: 점검 → 테스트 → 버전 → 변경 로그 → 빌드(AAB · iOS 아카이브) → 산출물 정리 → 알림.
 * 각 단계의 시간·결과를 모아 마지막에 요약(dist/<버전>/release.json)으로 남긴다.
 * --dry-run 이면 무엇을 할지만 보여 주고 아무것도 바꾸지 않는다.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { commitsSince, lastTag, prependChangelog, renderChangelog } from './commits.ts';
import { bump, recommendBump, type AppVersion } from './semver.ts';
import { current, writeAll } from './versionFiles.ts';

export interface ReleaseOptions {
  root: string;
  platforms: ('android' | 'ios')[];
  bump?: string;
  dryRun: boolean;
  skipTests: boolean;
  skipBuild: boolean;
  allowDirty: boolean;
  log: (line: string) => void;
}

export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface Artifact {
  platform: string;
  path: string;
  bytes: number;
  sha256?: string;
}

export interface ReleaseSummary {
  from: AppVersion;
  to: AppVersion;
  since?: string;
  commits: number;
  steps: StepResult[];
  artifacts: Artifact[];
  dryRun: boolean;
  ok: boolean;
}

function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 폴더(.app·.xcarchive)면 안의 파일 크기 합 */
function sizeOf(path: string): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export async function release(o: ReleaseOptions): Promise<ReleaseSummary> {
  const steps: StepResult[] = [];
  const artifacts: Artifact[] = [];
  const step = async (name: string, fn: () => Promise<string | void> | string | void) => {
    const t0 = Date.now();
    o.log(`▶ ${name}`);
    try {
      const detail = (await fn()) ?? undefined;
      steps.push({ name, ok: true, ms: Date.now() - t0, detail });
      o.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return true;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      steps.push({ name, ok: false, ms: Date.now() - t0, detail });
      o.log(`  ✗ ${name} — ${detail}`);
      return false;
    }
  };

  const from = current(o.root);
  const since = lastTag(o.root);
  const { commits, skipped } = commitsSince(o.root, since);
  const kind = o.bump ?? recommendBump(commits, from.version);
  const to: AppVersion = { version: bump(from.version, kind), build: from.build + 1 };
  const summary = (): ReleaseSummary => ({ from, to, since, commits: commits.length, steps, artifacts, dryRun: o.dryRun, ok: steps.every((s) => s.ok) });

  o.log(`${from.version} (${from.build}) → ${to.version} (${to.build})  [${o.bump ? kind : `추천: ${kind}`}, ${since ?? '처음'} 이후 커밋 ${commits.length}개${skipped ? `, 형식 밖 ${skipped}개` : ''}]`);

  const go =
    (await step('작업 트리 점검', () => {
      const dirty = sh(o.root, 'git', ['status', '--porcelain']).out.trim();
      if (dirty && !o.allowDirty && !o.dryRun) throw new Error('커밋하지 않은 변경이 있습니다(--allow-dirty로 무시)');
      return dirty ? '변경 있음(허용)' : '깨끗함';
    })) &&
    (o.skipTests ||
      o.dryRun ||
      (await step('앱 테스트(Jest·tsc·ESLint)', () => {
        const r = sh(o.root, 'ci/app-js.sh', []);
        if (!r.ok) throw new Error(r.out.split('\n').slice(-15).join('\n'));
        return /Tests:\s+(.+)/.exec(r.out)?.[1];
      })));
  if (!go) return summary();

  await step('버전 맞추기', () => {
    const changed = writeAll(o.root, to, o.dryRun);
    return `${o.dryRun ? '(바꿀 파일) ' : ''}${changed.join(', ') || '변경 없음'}`;
  });

  await step('변경 로그', () => {
    const section = renderChangelog(to.version, new Date().toISOString().slice(0, 10), commits);
    if (o.dryRun) {
      o.log(section.split('\n').map((l) => `    ${l}`).join('\n'));
      return '미리 보기';
    }
    const path = join(o.root, 'CHANGELOG.md');
    writeFileSync(path, prependChangelog(existsSync(path) ? readFileSync(path, 'utf8') : '', section));
    return 'CHANGELOG.md';
  });

  if (o.dryRun || o.skipBuild) return summary();

  const dist = join(o.root, 'dist', to.version);
  mkdirSync(dist, { recursive: true });
  const mobile = join(o.root, 'apps/mobile');

  if (o.platforms.includes('android')) {
    await step('Android 릴리스 번들(AAB)', () => {
      const java = sh(o.root, '/usr/libexec/java_home', ['-v', '17']).out.trim();
      const r = sh(join(mobile, 'android'), './gradlew', [
        '--no-daemon',
        'bundleRelease',
        '-PreactNativeArchitectures=arm64-v8a,armeabi-v7a,x86_64',
        // 로컬 미러(느린 네트워크용)에 릴리스 aar까지 있을 때만 쓴다. 없으면 Maven에서 받는다
        ...(process.env.RN_MAVEN_MIRROR ? [`-Preact.internal.mavenLocalRepo=${process.env.RN_MAVEN_MIRROR}`] : []),
      ], java ? { JAVA_HOME: java } : {});
      if (!r.ok) throw new Error(r.out.split('\n').slice(-20).join('\n'));
      const aab = join(mobile, 'android/app/build/outputs/bundle/release/app-release.aab');
      const out = join(dist, `hoga-${to.version}-${to.build}.aab`);
      copyFileSync(aab, out);
      artifacts.push({ platform: 'android', path: out, bytes: statSync(out).size, sha256: sha256(out) });
      return `${(statSync(out).size / 1e6).toFixed(1)} MB (디버그 키 서명 — 스토어 업로드용 아님)`;
    });
  }

  if (o.platforms.includes('ios')) {
    await step('iOS 아카이브(서명 없음)', () => {
      const archive = join(mobile, 'ios/build/release/HogaApp.xcarchive');
      const r = sh(join(mobile, 'ios'), 'xcodebuild', [
        '-workspace', 'HogaApp.xcworkspace', '-scheme', 'HogaApp', '-configuration', 'Release',
        '-destination', 'generic/platform=iOS', '-archivePath', archive, '-quiet', 'archive',
        'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO',
      ]);
      if (!r.ok) throw new Error(r.out.split('\n').filter((l) => /error/i.test(l)).slice(-10).join('\n') || 'xcodebuild archive failed');
      const out = join(dist, `HogaApp-${to.version}-${to.build}.xcarchive`);
      cpSync(archive, out, { recursive: true });
      const app = join(out, 'Products/Applications/HogaApp.app');
      if (!existsSync(join(app, 'main.jsbundle'))) throw new Error('아카이브에 JS 번들이 없습니다');
      artifacts.push({ platform: 'ios', path: out, bytes: sizeOf(app) });
      return `.app ${(sizeOf(app) / 1e6).toFixed(0)} MB, 서명은 Xcode Organizer/fastlane에서(개발자 계정 필요)`;
    });
  }

  const result = summary();
  writeFileSync(join(dist, 'release.json'), JSON.stringify(result, null, 2));
  return result;
}

/** 요약 한 덩어리(콘솔·Slack 공용) */
export function formatSummary(s: ReleaseSummary): string {
  const head = `${s.ok ? '✅' : '❌'} Hoga ${s.to.version} (${s.to.build})${s.dryRun ? ' [dry-run]' : ''} — ${s.commits} commits since ${s.since ?? 'start'}`;
  const steps = s.steps.map((x) => `${x.ok ? '✓' : '✗'} ${x.name} ${(x.ms / 1000).toFixed(1)}s`).join('\n');
  const arts = s.artifacts.map((a) => `• ${a.platform}: ${a.path.split('/').slice(-2).join('/')} ${(a.bytes / 1e6).toFixed(1)}MB`).join('\n');
  return [head, steps, arts].filter(Boolean).join('\n');
}

/** SLACK_WEBHOOK_URL이 있을 때만 보낸다(없으면 콘솔만) */
export async function notify(text: string, webhook = process.env.SLACK_WEBHOOK_URL): Promise<'sent' | 'skipped'> {
  if (!webhook) return 'skipped';
  const res = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`slack ${res.status}`);
  return 'sent';
}
