/**
 * 시세 메시지 이진 형식(v1). 정의·이유는 core/include/hoga/wire.hpp(C++ 디코더와 같은 형식).
 * 클라이언트가 /ws?proto=bin 으로 붙으면 gateway가 시세(snap·delta·trade)를 이 형식의 바이너리 프레임으로 보낸다.
 * 두 구현이 맞는지는 shared/protocol/wire-v1.json(골든 벡터)으로 양쪽에서 시험한다.
 */
import type { DeltaMessage, SnapshotMessage, TradeMessage, WireLevel } from './protocol.js';

export type MarketMessage = SnapshotMessage | DeltaMessage | TradeMessage;

const TYPE = { snap: 1, delta: 2, trade: 3 } as const;

class Writer {
  private buf = Buffer.allocUnsafe(64);
  private pos = 0;

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.pos + n));
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }

  byte(v: number) {
    this.ensure(1);
    this.buf[this.pos++] = v;
  }

  /** 부호 없는 LEB128. 2^53까지 정확(JS number) — 비트 연산 대신 나눗셈 */
  varint(v: number) {
    let n = Math.max(0, Math.floor(v));
    this.ensure(10);
    while (n >= 0x80) {
      this.buf[this.pos++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.pos++] = n;
  }

  symbol(s: string) {
    this.ensure(6);
    this.buf.write(s.padEnd(6, ' ').slice(0, 6), this.pos, 'latin1');
    this.pos += 6;
  }

  done(): Buffer {
    return this.buf.subarray(0, this.pos);
  }
}

export function encode(msg: MarketMessage): Buffer {
  const w = new Writer();
  w.byte(TYPE[msg.t]);
  w.symbol(msg.sym);
  switch (msg.t) {
    case 'snap':
      w.varint(msg.seq);
      w.varint(msg.ts);
      for (const side of [msg.bids, msg.asks]) {
        w.varint(side.length);
        for (const [px, qty] of side) {
          w.varint(px);
          w.varint(qty);
        }
      }
      break;
    case 'delta':
      w.varint(msg.seq);
      w.varint(msg.ts);
      w.byte(msg.side === 'B' ? 0 : 1);
      w.varint(msg.px);
      w.varint(msg.qty);
      break;
    case 'trade':
      w.varint(msg.ts);
      w.varint(msg.px);
      w.varint(msg.qty);
      w.byte(msg.aggr === 'B' ? 0 : msg.aggr === 'A' ? 1 : 2);
      break;
  }
  return w.done();
}

/** 버스의 JSON 원문 → 이진. 시세가 아니면 undefined */
export function encodeJson(payload: string): Buffer | undefined {
  const msg = JSON.parse(payload) as { t: string };
  return msg.t === 'snap' || msg.t === 'delta' || msg.t === 'trade' ? encode(msg as MarketMessage) : undefined;
}

/** 시험·디버그용 디코더(앱은 C++ hoga::wire::decode를 쓴다) */
export function decode(buf: Buffer): MarketMessage {
  let pos = 1;
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (pos >= buf.length) throw new Error('truncated');
      const b = buf[pos++]!;
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 0x80;
    }
  };
  const sym = buf.toString('latin1', pos, pos + 6).trimEnd();
  pos += 6;
  const side = () => (buf[pos++] === 0 ? 'B' : 'A') as 'B' | 'A';
  switch (buf[0]) {
    case 1: {
      const seq = varint();
      const ts = varint();
      const levels = (): WireLevel[] => Array.from({ length: varint() }, () => [varint(), varint()] as WireLevel);
      const bids = levels();
      const asks = levels();
      return { t: 'snap', sym, seq, ts, bids, asks };
    }
    case 2: {
      const seq = varint();
      const ts = varint();
      const s = side();
      return { t: 'delta', sym, seq, ts, side: s, px: varint(), qty: varint() };
    }
    case 3:
    {
      const ts = varint();
      const px = varint();
      const qty = varint();
      const a = buf[pos++];
      if (a === undefined || a > 2) throw new Error('bad aggressor');
      return { t: 'trade', sym, ts, px, qty, aggr: a === 0 ? 'B' : a === 1 ? 'A' : 'N' };
    }
    default:
      throw new Error(`unknown type ${buf[0]}`);
  }
}
