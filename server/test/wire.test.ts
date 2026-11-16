import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createServer, type HogaServer } from '../src/app.js';
import { TEST_OPTIONS } from './fixtures.js';
import { loadConfig } from '../src/config.js';
import { decode, encode, type MarketMessage } from '../src/wire.js';

const golden = JSON.parse(readFileSync(new URL('../../shared/protocol/wire-v1.json', import.meta.url), 'utf8')) as {
  vectors: { name: string; json: MarketMessage; hex: string }[];
};

describe('wire v1 (binary market data)', () => {
  it.each(golden.vectors.map((v) => [v.name, v] as const))('matches the shared golden vector: %s', (_name, v) => {
    expect(encode(v.json).toString('hex')).toBe(v.hex);
    expect(decode(Buffer.from(v.hex, 'hex'))).toEqual(v.json);
  });

  it('is about a quarter of the JSON size for deltas', () => {
    const delta: MarketMessage = { t: 'delta', sym: '000001', seq: 123456, ts: Date.now(), side: 'A', px: 71300, qty: 1200 };
    const ratio = encode(delta).length / Buffer.byteLength(JSON.stringify(delta));
    expect(ratio).toBeLessThan(0.3);
  });
});

const servers: HogaServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

async function client(server: HogaServer, query = '') {
  const ws = new WebSocket(`${server.url().replace('http', 'ws')}/ws${query}`);
  const frames: { binary: boolean; data: Buffer }[] = [];
  ws.on('message', (data, isBinary) => frames.push({ binary: isBinary, data: data as Buffer }));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, frames, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe('gateway ?proto=bin', () => {
  it('sends the same market data as binary frames, control messages stay JSON', async () => {
    const server = createServer(loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', SIM_INTERVAL_MS: '0' }), TEST_OPTIONS);
    await server.start();
    servers.push(server);
    server.market.warmUp(20);
    const json = await client(server);
    const bin = await client(server, '?proto=bin');
    json.send({ op: 'sub', symbols: ['000001'] });
    bin.send({ op: 'sub', symbols: ['000001'] });
    await new Promise((r) => setTimeout(r, 100));
    server.market.warmUp(10);
    await new Promise((r) => setTimeout(r, 100));

    // 'subscribed' 같은 제어 메시지는 JSON(텍스트)
    expect(bin.frames.some((f) => !f.binary && JSON.parse(f.data.toString()).t === 'subscribed')).toBe(true);
    const market = (frames: typeof bin.frames) =>
      frames.flatMap((f) => {
        const m = f.binary ? decode(f.data) : (JSON.parse(f.data.toString()) as { t: string });
        return m.t === 'snap' || m.t === 'delta' || m.t === 'trade' ? [m] : [];
      });
    const fromBin = market(bin.frames);
    expect(bin.frames.filter((f) => f.binary).length).toBe(fromBin.length);
    // 내용은 JSON 구독자가 받은 것과 같다(스냅샷의 ts만 보낸 순간이라 다를 수 있다)
    const strip = (ms: ReturnType<typeof market>) => ms.map((m) => (m.t === 'snap' ? { ...m, ts: 0 } : m));
    expect(strip(fromBin)).toEqual(strip(market(json.frames)));
    expect(fromBin.length).toBeGreaterThan(5);
    json.ws.close();
    bin.ws.close();
  });
});
