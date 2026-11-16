/** 앱 버전(x.y.z)과 빌드 번호(스토어가 요구하는, 계속 늘어나는 정수) */
export interface AppVersion {
  version: string;
  build: number;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function bump(current: string, what: 'major' | 'minor' | 'patch' | string): string {
  if (SEMVER.test(what)) return what;
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`not a semver: ${current}`);
  const [maj, min, pat] = m.slice(1).map(Number) as [number, number, number];
  switch (what) {
    case 'major':
      return `${maj + 1}.0.0`;
    case 'minor':
      return `${maj}.${min + 1}.0`;
    case 'patch':
      return `${maj}.${min}.${pat + 1}`;
    default:
      throw new Error(`bump must be major | minor | patch | x.y.z (got ${what})`);
  }
}

export function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Conventional Commits로 다음 버전 종류를 고른다(1.0 전에는 큰 변경도 minor) */
export function recommendBump(types: { type: string; breaking: boolean }[], current: string): 'major' | 'minor' | 'patch' {
  const preOne = current.startsWith('0.');
  if (types.some((t) => t.breaking)) return preOne ? 'minor' : 'major';
  if (types.some((t) => t.type === 'feat')) return 'minor';
  return 'patch';
}
