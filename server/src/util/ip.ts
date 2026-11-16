import { isIPv6 } from 'node:net';

/**
 * IP 기준 제한에 쓸 키. IPv6는 한 가입자가 /64 안의 주소를 마음대로 바꿔 쓸 수 있어 /64 단위로 묶는다.
 * IPv4와 IPv4-mapped IPv6(::ffff:1.2.3.4)는 주소 그대로.
 */
export function rateLimitKey(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const lower = ip.toLowerCase().split('%')[0]!;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return mapped[1]!;
  const [head, tail = ''] = lower.split('::');
  const left = head ? head.split(':') : [];
  const right = lower.includes('::') && tail ? tail.split(':') : [];
  const groups = lower.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
