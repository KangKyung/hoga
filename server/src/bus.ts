/**
 * 시세 메시지 전달 계층.
 *
 * market(단일 작성자)이 종목 채널에 발행하고 gateway(여러 대)가 구독한다.
 * 지금은 한 프로세스 안의 메모리 구현만 있다. 여러 프로세스로 나눌 때는 같은 인터페이스로
 * Redis Pub/Sub 구현을 끼운다(M6). payload는 이미 직렬화된 문자열이라 구독자 수와 무관하게
 * 직렬화는 한 번만 일어난다.
 */
export type MessageKind = 'book' | 'trade';

export type BusHandler = (symbol: string, kind: MessageKind, payload: string) => void;

export interface Bus {
  publish(symbol: string, kind: MessageKind, payload: string): void;
  /** 모든 종목 채널을 구독. 반환 함수로 해제 */
  subscribeAll(handler: BusHandler): () => void;
  close(): Promise<void>;
}

export class InMemoryBus implements Bus {
  private readonly handlers = new Set<BusHandler>();

  publish(symbol: string, kind: MessageKind, payload: string): void {
    for (const handler of this.handlers) handler(symbol, kind, payload);
  }

  subscribeAll(handler: BusHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
