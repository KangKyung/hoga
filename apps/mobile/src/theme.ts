/** 국내 관례: 상승 빨강, 하락 파랑, 보합 회색 */
export const colors = {
  bg: '#f3f5f7',
  card: '#ffffff',
  text: '#16202c',
  sub: '#4a5663',
  mute: '#7b8692',
  line: '#e3e7ec',
  accent: '#123c69',
  up: '#d6293e',
  upSoft: 'rgba(214, 41, 62, 0.10)',
  down: '#1f5fd1',
  downSoft: 'rgba(31, 95, 209, 0.10)',
  flat: '#5c6773',
  live: '#1f8a4c',
  warn: '#c27a00',
  danger: '#b3261e',
};

export function priceColor(price: number, base: number): string {
  if (price > base) return colors.up;
  if (price < base) return colors.down;
  return colors.flat;
}

export const formatPrice = (n: number) => n.toLocaleString('ko-KR');

export function formatChange(price: number, base: number): string {
  const diff = price - base;
  const pct = base ? (diff / base) * 100 : 0;
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
  return `${arrow}${formatPrice(Math.abs(diff))} (${diff >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(2)}%)`;
}

export const mono = {fontVariant: ['tabular-nums' as const]};
