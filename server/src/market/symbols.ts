/**
 * 모의 종목. 실제 회사·종목 코드와 무관한 가짜 데이터다.
 * 기준가는 각 가격대의 호가단위에 맞춰 두었다.
 */
export interface SymbolInfo {
  code: string;
  name: string;
  basePrice: number;
}

export const SYMBOLS: readonly SymbolInfo[] = [
  { code: '000001', name: '가상전자', basePrice: 71_200 },
  { code: '000002', name: '모의바이오', basePrice: 18_450 },
  { code: '000003', name: '시험화학', basePrice: 4_215 },
  { code: '000004', name: '연습금융', basePrice: 152_300 },
  { code: '000005', name: '샘플게임즈', basePrice: 1_234 },
];
