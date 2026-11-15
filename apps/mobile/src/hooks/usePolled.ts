import {useEffect, useRef, useState} from 'react';

/**
 * C++에서 값을 주기적으로 "끌어오는" 훅.
 *
 * 고빈도 시세를 이벤트로 JS에 밀어 넣지 않고, 화면이 그릴 수 있는 주기(hz)로만 읽는다.
 * key가 이전과 같으면 setState를 하지 않아 불필요한 렌더를 막는다.
 * requestAnimationFrame 기반이라 앱이 백그라운드면 자연히 멈춘다.
 */
export function usePolled<T>(read: () => T, keyOf: (value: T) => string, hz: number, deps: unknown[]): T {
  const readRef = useRef(read);
  const keyRef = useRef(keyOf);
  readRef.current = read;
  keyRef.current = keyOf;

  const [value, setValue] = useState<T>(() => read());

  useEffect(() => {
    let frame = 0;
    let last = 0;
    let prevKey = '';
    const interval = 1000 / hz;
    const tick = (time: number) => {
      if (time - last >= interval) {
        last = time;
        const next = readRef.current();
        const key = keyRef.current(next);
        if (key !== prevKey) {
          prevKey = key;
          setValue(next);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hz, ...deps]);

  return value;
}
