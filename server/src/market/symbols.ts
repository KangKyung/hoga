/**
 * 모의 종목. 실제 회사·종목 코드와 무관한 가짜 데이터다.
 * 기준가는 각 가격대의 호가단위에 맞춰 두었다.
 */
export type Sector = 'electronics' | 'bio' | 'chemical' | 'finance' | 'games';

export interface SymbolInfo {
  code: string;
  name: string;
  basePrice: number;
  sector: Sector;
  /** 상장주식수(모의) */
  sharesListed: number;
}

export const SYMBOLS: readonly SymbolInfo[] = [
  { code: '000001', name: '가상전자', basePrice: 71_200, sector: 'electronics', sharesListed: 5_969_782_550 },
  { code: '000002', name: '모의바이오', basePrice: 18_450, sector: 'bio', sharesListed: 71_174_000 },
  { code: '000003', name: '시험화학', basePrice: 4_215, sector: 'chemical', sharesListed: 48_000_000 },
  { code: '000004', name: '연습금융', basePrice: 152_300, sector: 'finance', sharesListed: 410_000_000 },
  { code: '000005', name: '샘플게임즈', basePrice: 1_234, sector: 'games', sharesListed: 35_500_000 },
];
