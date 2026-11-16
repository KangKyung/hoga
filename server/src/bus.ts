/**
 * 시세 메시지 전달 계층.
 *
 * market(단일 작성자)이 종목 채널에 발행하고 gateway(여러 대)가 구독한다.
 * 한 프로세스(ROLE=all)는 메모리 구현, 여러 프로세스(ROLE=market / gateway)는 같은 인터페이스의
 * Redis Pub/Sub 구현(src/redis/bus.ts)을 쓴다. payload는 이미 직렬화된 문자열이라 구독자 수와 무관하게
 * 직렬화는 한 번만 일어난다.
 */
export type MessageKind = 'book' | 'trade';

export type BusHandler = (symbol: string, kind: MessageKind, payload: string) => void;
export type UserHandler = (userId: string, payload: string) => void;
/** 관리 명령(예: 'disconnect'). 모든 gateway가 받는다 */
export type AdminHandler = (command: string) => void;

export interface Bus {
  publish(symbol: string, kind: MessageKind, payload: string): void;
  /** 모든 종목 채널을 구독. 반환 함수로 해제 */
  subscribeAll(handler: BusHandler): () => void;
  /** 사용자 전용 채널(주문 체결 알림 등). 그 사용자에게 붙은 gateway만 전달한다 */
  publishUser(userId: string, payload: string): void;
  subscribeUsers(handler: UserHandler): () => void;
  publishAdmin(command: string): void;
  subscribeAdmin(handler: AdminHandler): () => void;
  /** 구독이 끊겼다 다시 붙었을 때(놓친 메시지가 있을 수 있음). 메모리 버스는 끊기지 않는다 */
  onResubscribe(handler: () => void): () => void;
  close(): Promise<void>;
}

export class InMemoryBus implements Bus {
  private readonly handlers = new Set<BusHandler>();
  private readonly userHandlers = new Set<UserHandler>();
  private readonly adminHandlers = new Set<AdminHandler>();

  publish(symbol: string, kind: MessageKind, payload: string): void {
    for (const handler of this.handlers) handler(symbol, kind, payload);
  }

  subscribeAll(handler: BusHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  publishUser(userId: string, payload: string): void {
    for (const handler of this.userHandlers) handler(userId, payload);
  }

  subscribeUsers(handler: UserHandler): () => void {
    this.userHandlers.add(handler);
    return () => this.userHandlers.delete(handler);
  }

  publishAdmin(command: string): void {
    for (const handler of this.adminHandlers) handler(command);
  }

  subscribeAdmin(handler: AdminHandler): () => void {
    this.adminHandlers.add(handler);
    return () => this.adminHandlers.delete(handler);
  }

  onResubscribe(): () => void {
    return () => {};
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.userHandlers.clear();
    this.adminHandlers.clear();
  }
}
