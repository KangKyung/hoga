/**
 * Redis Pub/Sub 버스. market(단일 작성자)이 발행하고 gateway 여러 대가 구독한다.
 *
 * 채널: hoga:md:<종목>  (시세: 첫 글자 b=book · t=trade, 뒤는 이미 직렬화된 JSON)
 *       hoga:user:<id>  (내 주문 알림)
 *       hoga:admin      (관리 명령: 모든 gateway에서 연결 끊기 등)
 * Redis Pub/Sub은 한 연결 안에서 순서를 지키므로 종목별 seq 순서가 그대로 유지된다.
 * 구독 연결이 끊긴 동안의 메시지는 유실된다 → gateway는 복제 장부를 다시 받고, 클라이언트는 seq로 누락을 알아챈다.
 */
import { Redis } from 'ioredis';

import type { AdminHandler, Bus, BusHandler, MessageKind, UserHandler } from '../bus.js';

const MD = 'hoga:md:';
const USER = 'hoga:user:';
const ADMIN = 'hoga:admin';

export class RedisBus implements Bus {
  private readonly pub: Redis;
  private sub: Redis | undefined;
  private readonly handlers = new Set<BusHandler>();
  private readonly userHandlers = new Set<UserHandler>();
  private readonly adminHandlers = new Set<AdminHandler>();
  private readonly resubscribeHandlers = new Set<() => void>();

  constructor(private readonly url: string) {
    this.pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: null });
    this.pub.on('error', (err: Error) => this.reportError('pub', err));
  }

  private lastErrorLog = 0;
  /** 끊김은 ioredis가 알아서 다시 붙는다. 로그만 초당 한 번 남긴다 */
  private reportError(which: string, err: Error): void {
    const now = Date.now();
    if (now - this.lastErrorLog < 1_000) return;
    this.lastErrorLog = now;
    console.warn(`[redis:${which}] ${err.message}`);
  }

  /** 구독 연결은 처음 구독할 때 연다(market 전용 프로세스는 구독하지 않는다) */
  private subscriber(): Redis {
    if (this.sub) return this.sub;
    const sub = new Redis(this.url, { maxRetriesPerRequest: null });
    sub.on('error', (err: Error) => this.reportError('sub', err));
    sub.psubscribe(`${MD}*`, `${USER}*`).catch(() => {});
    sub.subscribe(ADMIN).catch(() => {});
    let first = true;
    sub.on('ready', () => {
      // 재연결: 끊긴 동안 놓친 시세가 있을 수 있다
      if (!first) for (const h of this.resubscribeHandlers) h();
      first = false;
    });
    sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      if (channel.startsWith(MD)) {
        const symbol = channel.slice(MD.length);
        const kind: MessageKind = message[0] === 'b' ? 'book' : message[0] === 's' ? 'status' : 'trade';
        const payload = message.slice(1);
        for (const h of this.handlers) h(symbol, kind, payload);
      } else if (channel.startsWith(USER)) {
        const userId = channel.slice(USER.length);
        for (const h of this.userHandlers) h(userId, message);
      }
    });
    sub.on('message', (channel: string, message: string) => {
      if (channel === ADMIN) for (const h of this.adminHandlers) h(message);
    });
    this.sub = sub;
    return sub;
  }

  publish(symbol: string, kind: MessageKind, payload: string): void {
    void this.pub.publish(MD + symbol, (kind === 'book' ? 'b' : kind === 'status' ? 's' : 't') + payload);
  }

  subscribeAll(handler: BusHandler): () => void {
    this.subscriber();
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  publishUser(userId: string, payload: string): void {
    void this.pub.publish(USER + userId, payload);
  }

  subscribeUsers(handler: UserHandler): () => void {
    this.subscriber();
    this.userHandlers.add(handler);
    return () => this.userHandlers.delete(handler);
  }

  publishAdmin(command: string): void {
    void this.pub.publish(ADMIN, command);
  }

  subscribeAdmin(handler: AdminHandler): () => void {
    this.subscriber();
    this.adminHandlers.add(handler);
    return () => this.adminHandlers.delete(handler);
  }

  onResubscribe(handler: () => void): () => void {
    this.resubscribeHandlers.add(handler);
    return () => this.resubscribeHandlers.delete(handler);
  }

  /** 구독 연결이 실제로 준비될 때까지(테스트·시작 순서용) */
  async ready(): Promise<void> {
    const sub = this.subscriber();
    if (sub.status !== 'ready') await new Promise<void>((resolve) => sub.once('ready', () => resolve()));
    // psubscribe/subscribe 응답까지 기다린다
    await sub.ping().catch(() => {});
  }

  /** 다른 저장소(멱등 키·토큰)가 같은 연결을 쓴다 */
  get client(): Redis {
    return this.pub;
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.userHandlers.clear();
    this.adminHandlers.clear();
    // Redis가 이미 죽었으면 quit()은 재연결을 기다리며 끝나지 않는다 → 1초 뒤 끊어 버린다
    const quit = (r: Redis | undefined) =>
      r
        ? Promise.race([r.quit().catch(() => {}), new Promise((done) => setTimeout(done, 1_000).unref())]).finally(() =>
            r.disconnect(),
          )
        : Promise.resolve();
    await Promise.allSettled([quit(this.pub), quit(this.sub)]);
  }
}
