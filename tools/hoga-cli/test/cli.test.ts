import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { commitsSince, parse, prependChangelog, renderChangelog } from '../src/commits.ts';
import { bump, recommendBump } from '../src/semver.ts';
import { FILES, current, readAll, writeAll } from '../src/versionFiles.ts';

describe('semver', () => {
  it('bumps and accepts explicit versions', () => {
    assert.equal(bump('0.6.3', 'patch'), '0.6.4');
    assert.equal(bump('0.6.3', 'minor'), '0.7.0');
    assert.equal(bump('0.6.3', 'major'), '1.0.0');
    assert.equal(bump('0.6.3', '2.0.0'), '2.0.0');
    assert.throws(() => bump('0.6.3', 'huge'));
  });

  it('recommends from Conventional Commits (breaking is minor before 1.0)', () => {
    assert.equal(recommendBump([{ type: 'fix', breaking: false }], '1.2.3'), 'patch');
    assert.equal(recommendBump([{ type: 'feat', breaking: false }], '1.2.3'), 'minor');
    assert.equal(recommendBump([{ type: 'fix', breaking: true }], '1.2.3'), 'major');
    assert.equal(recommendBump([{ type: 'fix', breaking: true }], '0.9.0'), 'minor');
  });
});

describe('commits', () => {
  it('parses headers, scopes and breaking changes', () => {
    assert.deepEqual(parse('abc', 'feat(server): Redis bus'), { hash: 'abc', type: 'feat', scope: 'server', breaking: false, subject: 'Redis bus' });
    assert.equal(parse('abc', 'fix!: drop v0 protocol')?.breaking, true);
    assert.equal(parse('abc', 'refactor: x\n\nBREAKING CHANGE: y')?.breaking, true);
    assert.equal(parse('abc', 'Merge branch main'), null);
  });

  it('renders grouped sections and prepends to an existing changelog', () => {
    const md = renderChangelog('0.7.0', '2026-11-16', [
      { hash: 'a1', type: 'feat', scope: 'app', breaking: false, subject: 'OTP' },
      { hash: 'b2', type: 'fix', breaking: false, subject: 'gateway shutdown' },
      { hash: 'c3', type: 'chore', breaking: true, subject: 'binary wire' },
    ]);
    assert.match(md, /^## 0\.7\.0 \(2026-11-16\)/);
    assert.match(md, /### ⚠️ 호환되지 않는 변경\n\n- binary wire \(c3\)/);
    assert.match(md, /### 새 기능\n\n- \*\*app:\*\* OTP \(a1\)/);
    assert.match(md, /### 기타\n\n- chore: binary wire/);
    const full = prependChangelog('# 변경 기록\n\n## 0.6.0 (old)\n', md);
    assert.ok(full.indexOf('0.7.0') < full.indexOf('0.6.0'));
    assert.equal(full.match(/# 변경 기록/g)?.length, 1);
  });

  it('reads git history since a ref', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoga-cli-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q');
    git('commit', '--allow-empty', '-qm', 'feat: one');
    git('tag', 'v0.1.0');
    git('commit', '--allow-empty', '-qm', 'fix(app): two');
    git('commit', '--allow-empty', '-qm', 'not conventional');
    const { commits, skipped } = commitsSince(dir, 'v0.1.0');
    assert.deepEqual(commits.map((c) => `${c.type}:${c.subject}`), ['fix:two']);
    assert.equal(skipped, 1);
  });
});

describe('version files', () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'hoga-ver-'));
    const put = (p: string, text: string) => {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), text);
    };
    put('apps/mobile/package.json', '{\n  "name": "HogaApp",\n  "version": "0.0.1",\n  "private": true\n}\n');
    put('apps/mobile/android/app/build.gradle', 'android {\n    defaultConfig {\n        versionCode 1\n        versionName "1.0"\n    }\n}\n');
    put(
      'apps/mobile/ios/HogaApp.xcodeproj/project.pbxproj',
      'Debug = {\n\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 1.0;\n};\nRelease = {\n\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 1.0;\n};\n',
    );
    return root;
  };

  it('finds the highest version and writes all files consistently', () => {
    const root = fixture();
    assert.deepEqual(current(root), { version: '1.0.0', build: 1 });
    assert.equal(readAll(root).find((r) => r.path.endsWith('version.ts'))?.error !== undefined, true); // 아직 없음
    const changed = writeAll(root, { version: '0.7.0', build: 7 }, false);
    assert.equal(changed.length, FILES.length);
    const pbx = readFileSync(join(root, 'apps/mobile/ios/HogaApp.xcodeproj/project.pbxproj'), 'utf8');
    assert.equal(pbx.match(/MARKETING_VERSION = 0\.7\.0;/g)?.length, 2); // Debug·Release 모두
    assert.match(readFileSync(join(root, 'apps/mobile/android/app/build.gradle'), 'utf8'), /versionCode 7\n\s+versionName "0\.7\.0"/);
    assert.match(readFileSync(join(root, 'apps/mobile/package.json'), 'utf8'), /"version": "0\.7\.0",\n  "private": true/);
    assert.deepEqual(readAll(root).map((r) => r.version), ['0.7.0', '0.7.0', '0.7.0', '0.7.0']);
    assert.deepEqual(writeAll(root, { version: '0.7.0', build: 7 }, false), []); // 두 번째는 바뀔 것 없음
  });

  it('dry-run reports but does not write', () => {
    const root = fixture();
    const before = readFileSync(join(root, 'apps/mobile/package.json'), 'utf8');
    assert.equal(writeAll(root, { version: '2.0.0', build: 9 }, true).length, FILES.length);
    assert.equal(readFileSync(join(root, 'apps/mobile/package.json'), 'utf8'), before);
  });
});
