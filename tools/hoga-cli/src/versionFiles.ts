/**
 * 버전이 들어 있는 파일들. 한 곳만 바꾸고 나머지를 잊는 실수를 막으려고 전부 한 번에 읽고 쓴다.
 *   apps/mobile/package.json            "version"
 *   apps/mobile/src/version.ts          화면·웹뷰 브리지가 쓰는 값(이 도구가 만든다)
 *   apps/mobile/android/app/build.gradle versionName · versionCode
 *   apps/mobile/ios/.../project.pbxproj  MARKETING_VERSION · CURRENT_PROJECT_VERSION (Debug·Release 모두)
 * 각 파일은 "텍스트 → 텍스트" 순수 함수로 고친다(시험하기 쉽고, 다른 줄은 건드리지 않는다).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AppVersion } from './semver.ts';

export interface VersionFile {
  path: string;
  read(text: string): AppVersion | { version: string; build?: number };
  write(text: string, v: AppVersion): string;
}

const one = (text: string, re: RegExp, what: string): string => {
  const m = re.exec(text);
  if (!m?.[1]) throw new Error(`${what} not found`);
  return m[1];
};

export const FILES: VersionFile[] = [
  {
    path: 'apps/mobile/package.json',
    read: (t) => ({ version: (JSON.parse(t) as { version: string }).version }),
    write: (t, v) => t.replace(/("version":\s*")[^"]+(")/, `$1${v.version}$2`),
  },
  {
    path: 'apps/mobile/src/version.ts',
    read: (t) => ({ version: one(t, /APP_VERSION = '([^']+)'/, 'APP_VERSION'), build: Number(one(t, /APP_BUILD = (\d+)/, 'APP_BUILD')) }),
    write: (_t, v) =>
      `// tools/hoga-cli가 만든다(직접 고치지 말 것): hoga version <x.y.z|patch|minor|major>\nexport const APP_VERSION = '${v.version}';\nexport const APP_BUILD = ${v.build};\n`,
  },
  {
    path: 'apps/mobile/android/app/build.gradle',
    read: (t) => ({ version: one(t, /versionName "([^"]+)"/, 'versionName'), build: Number(one(t, /versionCode (\d+)/, 'versionCode')) }),
    write: (t, v) => t.replace(/versionCode \d+/, `versionCode ${v.build}`).replace(/versionName "[^"]+"/, `versionName "${v.version}"`),
  },
  {
    path: 'apps/mobile/ios/HogaApp.xcodeproj/project.pbxproj',
    read: (t) => ({
      version: one(t, /MARKETING_VERSION = ([^;]+);/, 'MARKETING_VERSION'),
      build: Number(one(t, /CURRENT_PROJECT_VERSION = (\d+);/, 'CURRENT_PROJECT_VERSION')),
    }),
    write: (t, v) =>
      t
        .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${v.version};`)
        .replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${v.build};`),
  },
];

export function readAll(root: string): { path: string; version: string; build?: number; error?: string }[] {
  return FILES.map((f) => {
    try {
      return { path: f.path, ...f.read(readFileSync(join(root, f.path), 'utf8')) };
    } catch (e) {
      return { path: f.path, version: '?', error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** 지금 값: 가장 높은 버전·빌드(어긋나 있으면 맞춘다) */
export function current(root: string): AppVersion {
  const all = readAll(root).filter((r) => !r.error && /^\d+\.\d+(\.\d+)?$/.test(r.version));
  const norm = (v: string) => (v.split('.').length === 2 ? `${v}.0` : v);
  const version = all.map((r) => norm(r.version)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? '0.0.0';
  const build = Math.max(0, ...all.map((r) => r.build ?? 0));
  return { version, build };
}

export function writeAll(root: string, v: AppVersion, dryRun: boolean): string[] {
  const changed: string[] = [];
  for (const f of FILES) {
    const p = join(root, f.path);
    let before = '';
    try {
      before = readFileSync(p, 'utf8');
    } catch {
      // version.ts는 처음에 없을 수 있다
    }
    const after = f.write(before, v);
    if (after !== before) {
      changed.push(f.path);
      if (!dryRun) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, after);
      }
    }
  }
  return changed;
}
