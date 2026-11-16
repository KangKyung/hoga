import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 모의 사용자. 개발·테스트용 값이며 실제 계정이 아니다.
 * 비밀번호는 시작할 때 scrypt로 해시하고 평문은 메모리에 남기지 않는다.
 * 로그인·가입은 비동기 scrypt(libuv 스레드 풀)라 해시 계산이 시세·매칭 이벤트 루프를 막지 않는다.
 */
const SEED = [
  { id: 'u-demo', username: 'demo', name: '데모 사용자', password: 'hoga-demo-1234' },
  { id: 'u-trader2', username: 'trader2', name: '두번째 사용자', password: 'hoga-trader-5678' },
] as const;

export interface User {
  id: string;
  username: string;
  name: string;
}

interface StoredUser extends User {
  salt: Buffer;
  hash: Buffer;
}

const KEY_LEN = 32;

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const hashPassword = (password: string, salt: Buffer) => scryptAsync(password, salt, KEY_LEN);

export class UserStore {
  private readonly byUsername = new Map<string, StoredUser>();

  constructor() {
    for (const { password, ...user } of SEED) {
      const salt = randomBytes(16);
      // 시작할 때 한 번(시드 2명)이라 동기로
      this.byUsername.set(user.username, { ...user, salt, hash: scryptSync(password, salt, KEY_LEN) });
    }
  }

  /** 맞으면 사용자, 아니면 undefined. 사용자가 없어도 해시 비용을 똑같이 써서 존재 여부를 숨긴다. */
  async verify(username: string, password: string): Promise<User | undefined> {
    const stored = this.byUsername.get(username);
    const salt = stored?.salt ?? randomBytes(16);
    const candidate = await hashPassword(password, salt);
    if (!stored || !timingSafeEqual(candidate, stored.hash)) return undefined;
    return { id: stored.id, username: stored.username, name: stored.name };
  }

  has(username: string): boolean {
    return this.byUsername.has(username);
  }

  /** 계좌 개설로 새 사용자. 이미 있으면 undefined */
  async add(user: User, password: string): Promise<User | undefined> {
    if (this.byUsername.has(user.username)) return undefined;
    const salt = randomBytes(16);
    const hash = await hashPassword(password, salt);
    // 해시를 계산하는 동안 같은 이름이 먼저 들어왔을 수 있다
    if (this.byUsername.has(user.username)) return undefined;
    this.byUsername.set(user.username, { ...user, salt, hash });
    return { ...user };
  }

  get(id: string): User | undefined {
    for (const u of this.byUsername.values()) if (u.id === id) return { id: u.id, username: u.username, name: u.name };
    return undefined;
  }
}
