/**
 * 키별 직렬화(한 프로세스 안). 같은 키의 작업은 앞 작업이 끝난 뒤에 시작한다.
 *
 * 저장소 읽기 → 판단 → 쓰기 사이에 await가 끼면, 동시에 들어온 요청이 같은 옛 값을 읽고 서로 덮어쓴다
 * (예: OTP 실패 횟수). 이 서버에서 REST는 market 프로세스 한 곳만 처리하므로 프로세스 안 직렬화로 충분하다.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    // 마지막 작업이 끝나면 자리를 비운다(키가 무한히 쌓이지 않게)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  get size(): number {
    return this.tails.size;
  }
}
