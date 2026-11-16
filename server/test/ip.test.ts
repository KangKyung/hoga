import { describe, expect, it } from 'vitest';

import { createServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { rateLimitKey } from '../src/util/ip.js';
import { TEST_OPTIONS } from './fixtures.js';

describe('IP 제한 키', () => {
  it('IPv6는 /64로 묶고 IPv4는 그대로', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
  });

  it('TRUST_PROXY로 지정한 프록시에서 온 요청만 X-Forwarded-For를 믿는다', async () => {
    const base = { PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', SIM_INTERVAL_MS: '0', HISTORY_MINUTES: '0' } as const;
    for (const [env, expected] of [
      [{}, '127.0.0.1'],
      [{ TRUST_PROXY: '127.0.0.1' }, '198.51.100.4'],
      [{ TRUST_PROXY: '10.0.0.1' }, '127.0.0.1'],
    ] as const) {
      const server = createServer(loadConfig({ ...base, ...env }), TEST_OPTIONS);
      server.app.get('/test/ip', async (request) => ({ ip: request.ip }));
      await server.start();
      const res = await fetch(`${server.url()}/test/ip`, { headers: { 'x-forwarded-for': '198.51.100.4' } });
      expect(((await res.json()) as { ip: string }).ip).toBe(expected);
      await server.stop();
    }
  });
});
