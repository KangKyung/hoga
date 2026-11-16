/**
 * "JS 경유 vs C++ 직접" 비교 실험을 자동으로 돌린다(두 플랫폼 같은 코드).
 *
 * 부하 단계마다(관리 API로 시세 속도 조절) 앱의 성능 실험 화면에서 두 모드를 10초씩 측정한다.
 * - 앱이 화면에 내보내는 값: JS FPS, JS 이벤트 루프 지연(평균·최대), 초당 렌더, 초당 JS로 넘어온 메시지, 초당 수신
 * - 호스트에서 재는 값: 앱 프로세스 CPU(누적 CPU 시간 ÷ 경과 시간, 100% = 코어 1개)
 * - Android는 UI 스레드 프레임 통계(dumpsys gfxinfo: 느린 프레임 비율, p90)도 함께 남긴다.
 * 결과: reports/bench-<platform>.json
 */
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {admin, resetFaults, signInFresh, tap, waitForText} from '../support/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADB = process.env.ADB ?? path.join(process.env.HOME ?? '', 'Library/Android/sdk/platform-tools/adb');

const LEVELS = [
  {name: 'base', simIntervalMs: 100, simBurst: 1},
  {name: 'high', simIntervalMs: 10, simBurst: 2},
  {name: 'extreme', simIntervalMs: 10, simBurst: 6},
] as const;
const MODES = ['cpp', 'js'] as const;

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, {encoding: 'utf8'}).trim();

/** 앱 프로세스의 누적 CPU 시간(초) */
function cpuSeconds(): number {
  if (driver.isIOS) {
    // 시뮬레이터 앱은 맥의 프로세스다. ps TIME = [분:]초.소수
    const pid = sh('pgrep', ['-f', 'HogaApp.app/HogaApp']).split('\n')[0]!;
    const time = sh('ps', ['-p', pid, '-o', 'time=']);
    return time.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  }
  const pid = sh(ADB, ['shell', 'pidof', 'com.hogaapp']);
  const stat = sh(ADB, ['shell', 'cat', `/proc/${pid}/stat`]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // utime(14번째), stime(15번째) — ')' 뒤 기준 index 11, 12. 단위는 클록 틱(100Hz)
  return (Number(fields[11]) + Number(fields[12])) / 100;
}

function gfxReset() {
  if (!driver.isIOS) sh(ADB, ['shell', 'dumpsys', 'gfxinfo', 'com.hogaapp', 'reset']);
}

function gfxRead() {
  if (driver.isIOS) return undefined;
  const out = sh(ADB, ['shell', 'dumpsys', 'gfxinfo', 'com.hogaapp']);
  const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? NaN);
  return {
    frames: num(/Total frames rendered: (\d+)/),
    jankyPct: num(/Janky frames: \d+ \(([\d.]+)%\)/),
    p90Ms: num(/90th percentile: (\d+)ms/),
    p99Ms: num(/99th percentile: (\d+)ms/),
  };
}

function parseResult(text: string): Record<string, string | number> {
  return Object.fromEntries(
    text.split(' ').map(kv => {
      const [k, v] = kv.split('=');
      return [k!, Number.isNaN(Number(v)) ? v : Number(v)];
    }),
  );
}

describe('bench: JS-routed vs C++ direct', () => {
  const results: Record<string, unknown>[] = [];

  before(async () => {
    await resetFaults();
    await signInFresh();
    await tap('openSettings');
    await tap('openBench');
  });

  after(async () => {
    await resetFaults();
    const platform = driver.isIOS ? 'ios' : 'android';
    const dir = path.join(here, '..', 'reports');
    mkdirSync(dir, {recursive: true});
    const caps = driver.capabilities as Record<string, unknown>;
    writeFileSync(
      path.join(dir, `bench-${platform}.json`),
      JSON.stringify({platform, device: caps['appium:deviceName'] ?? caps.deviceName, at: new Date().toISOString(), results}, null, 2),
    );
    console.table(results);
  });

  for (const level of LEVELS) {
    for (const mode of MODES) {
      it(`${level.name} load, ${mode} mode`, async () => {
        await admin('PUT', '/faults', {simIntervalMs: level.simIntervalMs, simBurst: level.simBurst});
        await tap(`bench-mode-${mode}`);
        await browser.pause(2_000); // 모드 전환·부하 변화가 자리 잡도록

        gfxReset();
        const cpu0 = cpuSeconds();
        const t0 = Date.now();
        await tap('bench-run');
        const text = await waitForText('bench-result', s => s.startsWith(`mode=${mode} `), 40_000, 'bench result');
        const cpuPct = Math.round(((cpuSeconds() - cpu0) / ((Date.now() - t0) / 1000)) * 100);
        const ui = gfxRead();
        const row: Record<string, unknown> = {level: level.name, ...parseResult(text), cpuPct, ...(ui ? {ui} : {})};
        results.push(row);
        expect(Number(row.fps)).toBeGreaterThan(0);
      });
    }
  }
});
