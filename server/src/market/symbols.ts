/**
 * 모의 종목. 실제 회사·종목 코드와 무관한 가짜 데이터다.
 * 기준가는 각 가격대의 호가단위에 맞춰 두었다.
 */
import { roundToTick } from '../core.js';

export type Sector = 'electronics' | 'bio' | 'chemical' | 'finance' | 'games';

export interface SymbolInfo {
  code: string;
  name: string;
  basePrice: number;
  sector: Sector;
  /** 상장주식수(모의) */
  sharesListed: number;
  /**
   * 모의 주문 발생 빈도(0~1). 1이면 시뮬레이터 주기마다, 0.1이면 열 번에 한 번.
   * 실제 시장처럼 소수 종목에 거래가 몰리게 한다.
   */
  activity?: number;
}

export const CORE_SYMBOLS: readonly SymbolInfo[] = [
  { code: '000001', name: '가상전자', basePrice: 71_200, sector: 'electronics', sharesListed: 5_969_782_550 },
  { code: '000002', name: '모의바이오', basePrice: 18_450, sector: 'bio', sharesListed: 71_174_000 },
  { code: '000003', name: '시험화학', basePrice: 4_215, sector: 'chemical', sharesListed: 48_000_000 },
  { code: '000004', name: '연습금융', basePrice: 152_300, sector: 'finance', sharesListed: 410_000_000 },
  { code: '000005', name: '샘플게임즈', basePrice: 1_234, sector: 'games', sharesListed: 35_500_000 },
];

const PREFIXES = ['가상', '모의', '시험', '연습', '샘플', '예시', '가늠', '본보기'];
const SUFFIXES: Array<[string, Sector]> = [
  ['전자', 'electronics'],
  ['반도체', 'electronics'],
  ['디스플레이', 'electronics'],
  ['바이오', 'bio'],
  ['제약', 'bio'],
  ['화학', 'chemical'],
  ['소재', 'chemical'],
  ['에너지', 'chemical'],
  ['금융', 'finance'],
  ['증권', 'finance'],
  ['보험', 'finance'],
  ['게임즈', 'games'],
  ['엔터', 'games'],
  ['미디어', 'games'],
];

/** 결정적 난수(같은 순서로 항상 같은 종목이 나오게) */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 관심종목·전체 종목 화면용 추가 모의 종목(000006~). 이름·가격은 결정적으로 만든다.
 * 거래가 드문 종목이 많아야 "화면에 보이는 종목만 구독"의 효과가 드러난다.
 */
export function generatedSymbols(count: number, seed = 20_261_117): SymbolInfo[] {
  const random = mulberry32(seed);
  const used = new Set(CORE_SYMBOLS.map((s) => s.name));
  const out: SymbolInfo[] = [];
  for (let i = 0; out.length < count; i++) {
    const [suffix, sector] = SUFFIXES[Math.floor(random() * SUFFIXES.length)]!;
    const prefix = PREFIXES[Math.floor(random() * PREFIXES.length)]!;
    const name = `${prefix}${suffix}${used.has(prefix + suffix) ? ` ${String.fromCharCode(65 + (i % 26))}` : ''}`;
    if (used.has(name)) continue;
    used.add(name);
    // 1,000원 ~ 300,000원 로그 균등
    const raw = Math.exp(Math.log(1_000) + random() * (Math.log(300_000) - Math.log(1_000)));
    out.push({
      code: String(CORE_SYMBOLS.length + out.length + 1).padStart(6, '0'),
      name,
      basePrice: roundToTick(Math.round(raw), 'down'),
      sector,
      sharesListed: Math.round((10 + random() * 990) * 1_000_000),
      activity: Math.round((0.05 + random() * 0.35) * 100) / 100,
    });
  }
  return out;
}

/** 서버 기본 종목: 거래가 활발한 5종목 + 추가 115종목 */
export const SYMBOLS: readonly SymbolInfo[] = [...CORE_SYMBOLS, ...generatedSymbols(115)];
