/**
 * hoga — 릴리스 도우미
 *   hoga status                         파일마다 버전이 같은지
 *   hoga version <patch|minor|major|x.y.z> [--build N] [--dry-run]
 *   hoga changelog [--since <ref>] [--dry-run]
 *   hoga release [--platform android|ios|all] [--bump ...] [--dry-run] [--skip-tests] [--skip-build] [--allow-dirty]
 * 커밋·태그·푸시는 하지 않는다(사람이 확인하고 한다).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { commitsSince, lastTag, prependChangelog, renderChangelog } from './commits.ts';
import { formatSummary, notify, release } from './release.ts';
import { bump } from './semver.ts';
import { current, readAll, writeAll } from './versionFiles.ts';

function findRoot(start: string): string {
  let dir = resolve(start);
  while (!existsSync(join(dir, 'apps/mobile/package.json'))) {
    const up = resolve(dir, '..');
    if (up === dir) throw new Error('hoga 저장소 루트를 찾지 못했습니다');
    dir = up;
  }
  return dir;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    build: { type: 'string' },
    since: { type: 'string' },
    platform: { type: 'string', default: 'all' },
    bump: { type: 'string' },
    'skip-tests': { type: 'boolean', default: false },
    'skip-build': { type: 'boolean', default: false },
    'allow-dirty': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const root = findRoot(process.env.HOGA_CWD ?? process.cwd());
const dryRun = values['dry-run'];
const [command = 'status', arg] = positionals;

switch (command) {
  case 'status': {
    const rows = readAll(root);
    const versions = new Set(rows.filter((r) => !r.error).map((r) => r.version.replace(/^(\d+\.\d+)$/, '$1.0')));
    const builds = new Set(rows.filter((r) => r.build !== undefined).map((r) => r.build));
    for (const r of rows) console.log(`${r.error ? '✗' : ' '} ${r.path.padEnd(52)} ${r.version}${r.build !== undefined ? ` (${r.build})` : ''}${r.error ? `  ${r.error}` : ''}`);
    const ok = versions.size === 1 && builds.size <= 1 && rows.every((r) => !r.error);
    console.log(ok ? '\n버전이 모두 같습니다.' : '\n⚠️ 버전이 어긋나 있습니다 → hoga version <x.y.z>');
    process.exitCode = ok ? 0 : 1;
    break;
  }
  case 'version': {
    if (!arg) throw new Error('hoga version <patch|minor|major|x.y.z>');
    const from = current(root);
    const to = { version: bump(from.version, arg), build: values.build ? Number(values.build) : from.build + 1 };
    const changed = writeAll(root, to, dryRun);
    console.log(`${from.version} (${from.build}) → ${to.version} (${to.build})${dryRun ? ' [dry-run]' : ''}`);
    for (const f of changed) console.log(`  ${dryRun ? '~' : '✎'} ${f}`);
    break;
  }
  case 'changelog': {
    const since = values.since ?? lastTag(root);
    const { commits } = commitsSince(root, since);
    const section = renderChangelog(current(root).version, new Date().toISOString().slice(0, 10), commits);
    if (dryRun) console.log(section);
    else {
      const path = join(root, 'CHANGELOG.md');
      writeFileSync(path, prependChangelog(existsSync(path) ? readFileSync(path, 'utf8') : '', section));
      console.log(`CHANGELOG.md ← ${commits.length} commits since ${since ?? 'start'}`);
    }
    break;
  }
  case 'release': {
    const platforms = values.platform === 'all' ? (['android', 'ios'] as const) : ([values.platform] as ('android' | 'ios')[]);
    const summary = await release({
      root,
      platforms: [...platforms],
      bump: values.bump,
      dryRun,
      skipTests: values['skip-tests'],
      skipBuild: values['skip-build'],
      allowDirty: values['allow-dirty'],
      log: (l) => console.log(l),
    });
    const text = formatSummary(summary);
    console.log(`\n${text}`);
    if (!dryRun) console.log(`알림: ${await notify(text).catch((e: Error) => `실패 ${e.message}`)}`);
    if (values.json) console.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.ok ? 0 : 1;
    break;
  }
  default:
    console.error(`unknown command: ${command}`);
    process.exitCode = 2;
}
