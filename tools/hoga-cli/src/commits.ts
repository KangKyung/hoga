/** Conventional Commits 읽기·변경 로그 만들기 */
import { execFileSync } from 'node:child_process';

export interface Commit {
  hash: string;
  type: string;
  scope?: string;
  breaking: boolean;
  subject: string;
}

const HEADER = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;

export function parse(hash: string, message: string): Commit | null {
  const [header = '', ...body] = message.split('\n');
  const m = HEADER.exec(header.trim());
  if (!m) return null;
  return {
    hash,
    type: m[1]!.toLowerCase(),
    scope: m[2],
    breaking: Boolean(m[3]) || body.some((l) => /^BREAKING[ -]CHANGE:/.test(l)),
    subject: m[4]!.trim(),
  };
}

const SEP = '\u001e';
const FIELD = '\u001f';

/** since 이후의 커밋(없으면 처음부터). 형식이 맞지 않는 커밋은 따로 센다 */
export function commitsSince(root: string, since?: string): { commits: Commit[]; skipped: number } {
  const range = since ? [`${since}..HEAD`] : ['HEAD'];
  const out = execFileSync('git', ['log', `--format=%h${FIELD}%B${SEP}`, ...range], { cwd: root, encoding: 'utf8' });
  const commits: Commit[] = [];
  let skipped = 0;
  for (const chunk of out.split(SEP)) {
    const [hash, message] = chunk.trim().split(FIELD);
    if (!hash || !message) continue;
    const c = parse(hash, message);
    if (c) commits.push(c);
    else skipped++;
  }
  return { commits, skipped };
}

export function lastTag(root: string): string | undefined {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

const SECTIONS: [string, string][] = [
  ['feat', '새 기능'],
  ['fix', '버그 수정'],
  ['perf', '성능'],
  ['refactor', '구조 개선'],
  ['test', '테스트'],
  ['ci', 'CI·자동화'],
  ['docs', '문서'],
];

export function renderChangelog(version: string, date: string, commits: Commit[]): string {
  const lines = [`## ${version} (${date})`, ''];
  const breaking = commits.filter((c) => c.breaking);
  if (breaking.length) {
    lines.push('### ⚠️ 호환되지 않는 변경', '', ...breaking.map((c) => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject} (${c.hash})`), '');
  }
  for (const [type, title] of SECTIONS) {
    const items = commits.filter((c) => c.type === type);
    if (!items.length) continue;
    lines.push(`### ${title}`, '', ...items.map((c) => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject} (${c.hash})`), '');
  }
  const other = commits.filter((c) => !SECTIONS.some(([t]) => t === c.type));
  if (other.length) lines.push('### 기타', '', ...other.map((c) => `- ${c.type}: ${c.subject} (${c.hash})`), '');
  return lines.join('\n');
}

/** CHANGELOG.md 맨 위(제목 아래)에 새 절을 넣는다 */
export function prependChangelog(existing: string, section: string): string {
  const title = '# 변경 기록\n\n';
  const body = existing.startsWith('# ') ? existing.slice(existing.indexOf('\n') + 1).replace(/^\n+/, '') : existing;
  return `${title}${section.trimEnd()}\n\n${body}`.trimEnd() + '\n';
}
