/**
 * 비교 실험 결과(docs/bench/*.json)를 README용 SVG 하나로 그린다.
 * 작은 그래프 4개(축은 각각 하나): iOS JS FPS · iOS JS 최대 지연 · 앱 CPU(iOS, Android).
 * 값은 두 번 잰 것의 평균. 사용: node e2e/tools/bench-chart.mjs
 */
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'docs/bench');
const LEVELS = ['base', 'high', 'extreme'];
const MODES = ['cpp', 'js'];

function load(platform) {
  const runs = readdirSync(dir)
    .filter(f => f.startsWith(`bench-${platform}-run`))
    .map(f => JSON.parse(readFileSync(path.join(dir, f), 'utf8')).results);
  const avg = (level, mode, key) => {
    const vals = runs.map(r => r.find(x => x.level === level && x.mode === mode)?.[key]).filter(v => typeof v === 'number');
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  };
  return {avg, received: level => avg(level, 'cpp', 'received')};
}

const ios = load('ios');
const android = load('android');
const panels = [
  {title: 'iOS · JS FPS (높을수록 좋음)', get: (l, m) => ios.avg(l, m, 'fps'), max: 60, unit: ''},
  {title: 'iOS · JS 최대 지연 ms (낮을수록 좋음)', get: (l, m) => ios.avg(l, m, 'lagMax'), max: 200, unit: ''},
  {title: 'iOS · 앱 CPU % (코어 1개 = 100)', get: (l, m) => ios.avg(l, m, 'cpuPct'), max: 200, unit: ''},
  {title: 'Android · 앱 CPU % (코어 1개 = 100)', get: (l, m) => android.avg(l, m, 'cpuPct'), max: 200, unit: ''},
];
const levelLabel = l => `${{base: '기본', high: '높음', extreme: '매우 높음'}[l]} ~${ios.received(l).toLocaleString('en-US')}/s`;

const W = 790, PW = 360, PH = 220, GAP = 16, TOP = 76, PAD = 28;
const H = TOP + 2 * PH + GAP + 40;
const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif" role="img" aria-label="JS 경유 vs C++ 직접 비교 실험 결과">`);
out.push(`<style>
  .bg{fill:#fcfcfb}.t1{fill:#0b0b0b}.t2{fill:#52514e}.grid{stroke:#e4e3df}.base{stroke:#b9b8b2}
  .cpp{fill:#2a78d6}.js{fill:#eb6834}
  @media (prefers-color-scheme: dark){.bg{fill:#1a1a19}.t1{fill:#f0efec}.t2{fill:#c3c2b7}.grid{stroke:#383835}.base{stroke:#5a5955}.cpp{fill:#3987e5}.js{fill:#d95926}}
</style>`);
out.push(`<rect class="bg" width="${W}" height="${H}" rx="8"/>`);
out.push(`<text class="t1" x="${PAD}" y="30" font-size="16" font-weight="700">JS 경유(매 틱 이벤트) vs C++ 직접 + pull — 초당 수신 메시지별</text>`);
// 범례
out.push(`<rect class="cpp" x="${PAD}" y="44" width="12" height="12" rx="2"/><text class="t2" x="${PAD + 18}" y="54" font-size="12">C++ 직접 + JSI pull (앱 실제 경로)</text>`);
out.push(`<rect class="js" x="${PAD + 230}" y="44" width="12" height="12" rx="2"/><text class="t2" x="${PAD + 248}" y="54" font-size="12">JS 경유 (메시지마다 이벤트 → JSON.parse → setState)</text>`);

panels.forEach((p, i) => {
  const ox = PAD + (i % 2) * (PW + 12);
  const oy = TOP + Math.floor(i / 2) * (PH + GAP);
  const plotTop = oy + 40, plotH = PH - 80, plotBottom = plotTop + plotH;
  out.push(`<text class="t1" x="${ox}" y="${oy + 12}" font-size="13" font-weight="600">${p.title}</text>`);
  for (const f of [0, 0.5, 1]) {
    const y = plotBottom - f * plotH;
    out.push(`<line class="${f ? 'grid' : 'base'}" x1="${ox}" x2="${ox + PW - 20}" y1="${y}" y2="${y}" stroke-width="1"/>`);
    out.push(`<text class="t2" x="${ox + PW - 16}" y="${y + 4}" font-size="10">${Math.round(p.max * f)}</text>`);
  }
  const groupW = (PW - 30) / LEVELS.length, barW = 26;
  LEVELS.forEach((level, li) => {
    const cx = ox + groupW * li + groupW / 2;
    MODES.forEach((mode, mi) => {
      const v = p.get(level, mode);
      const h = Math.max(2, (Math.min(v, p.max) / p.max) * plotH);
      const x = cx - barW - 1 + mi * (barW + 2);
      const y = plotBottom - h;
      // 위쪽 모서리만 둥글게(기준선에 붙은 쪽은 각지게)
      out.push(`<path class="${mode}" d="M${x},${plotBottom} V${y + 4} Q${x},${y} ${x + 4},${y} H${x + barW - 4} Q${x + barW},${y} ${x + barW},${y + 4} V${plotBottom} Z"><title>${levelLabel(level)} · ${mode === 'cpp' ? 'C++ 직접' : 'JS 경유'}: ${v}</title></path>`);
      out.push(`<text class="t1" x="${x + barW / 2}" y="${y - 4}" font-size="11" text-anchor="middle">${v}</text>`);
    });
    out.push(`<text class="t2" x="${cx}" y="${plotBottom + 16}" font-size="11" text-anchor="middle">${levelLabel(level)}</text>`);
  });
});
out.push(`<text class="t2" x="${PAD}" y="${H - 24}" font-size="10">조건: 맥북 M4 한 대 · iPhone 17 Pro 시뮬레이터(iOS 26.4) · Pixel 9 에뮬레이터(Android 17) · RN 0.88 Debug(Hermes) · 측정 10초 × 2회 평균</text>`);
out.push(`<text class="t2" x="${PAD}" y="${H - 10}" font-size="10">Android JS FPS는 에뮬레이터 화면 주사율이 30/60Hz로 바뀌어(모드와 무관) 비교에서 뺐다. 원자료: docs/bench/*.json</text>`);
out.push('</svg>');
writeFileSync(path.join(root, 'docs/m6-bench.svg'), out.join('\n'));
console.log('wrote docs/m6-bench.svg');
