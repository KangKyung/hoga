/**
 * JS 스레드 성능 측정(비교 실험용).
 *
 * - JS FPS: requestAnimationFrame 콜백이 1초에 몇 번 불렸는가. JS 스레드가 바쁘면 콜백이 밀려 줄어든다.
 * - 이벤트 루프 지연: 50ms 타이머가 실제로 얼마나 늦게 불렸는가. 사용자가 버튼을 눌렀을 때
 *   onPress가 기다려야 하는 시간과 같은 성질이라 "버튼 반응 지연"의 근사값으로 쓴다.
 *
 * 숫자는 1초마다 한 번만 setState해서 측정 자체가 렌더를 늘리지 않게 한다.
 */
import {useEffect, useRef, useState} from 'react';

export interface PerfSample {
  /** 직전 1초 동안의 rAF 콜백 수 */
  jsFps: number;
  /** 직전 1초 동안 타이머 지연의 평균·최대(ms) */
  lagAvgMs: number;
  lagMaxMs: number;
  /** 직전 1초 동안 센 값(렌더 횟수, 받은 메시지 수 등) */
  counters: Record<string, number>;
}

const LAG_PROBE_MS = 50;

export class PerfCollector {
  private frames = 0;
  private lagSum = 0;
  private lagMax = 0;
  private lagCount = 0;
  private counts: Record<string, number> = {};

  frame(): void {
    this.frames += 1;
  }

  lag(ms: number): void {
    const v = Math.max(0, ms);
    this.lagSum += v;
    this.lagCount += 1;
    if (v > this.lagMax) this.lagMax = v;
  }

  count(name: string, n = 1): void {
    this.counts[name] = (this.counts[name] ?? 0) + n;
  }

  /** elapsedMs 동안 모은 값을 초당 값으로 바꾸고 초기화 */
  flush(elapsedMs: number): PerfSample {
    const perSec = (n: number) => Math.round((n * 1000) / Math.max(1, elapsedMs));
    const counters: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.counts)) counters[k] = perSec(v);
    const sample: PerfSample = {
      jsFps: perSec(this.frames),
      lagAvgMs: this.lagCount ? Math.round(this.lagSum / this.lagCount) : 0,
      lagMaxMs: Math.round(this.lagMax),
      counters,
    };
    this.frames = 0;
    this.lagSum = 0;
    this.lagMax = 0;
    this.lagCount = 0;
    this.counts = {};
    return sample;
  }
}

const EMPTY: PerfSample = {jsFps: 0, lagAvgMs: 0, lagMaxMs: 0, counters: {}};

/** collector에 쌓인 값을 1초마다 화면용 값으로 내보낸다 */
export function usePerfMeter(collector: PerfCollector): PerfSample {
  const [sample, setSample] = useState<PerfSample>(EMPTY);
  const ref = useRef(collector);
  ref.current = collector;

  useEffect(() => {
    let raf = 0;
    const onFrame = () => {
      ref.current.frame();
      raf = requestAnimationFrame(onFrame);
    };
    raf = requestAnimationFrame(onFrame);

    let expected = Date.now() + LAG_PROBE_MS;
    const probe = setInterval(() => {
      const now = Date.now();
      ref.current.lag(now - expected);
      expected = now + LAG_PROBE_MS;
    }, LAG_PROBE_MS);

    let last = Date.now();
    const report = setInterval(() => {
      const now = Date.now();
      setSample(ref.current.flush(now - last));
      last = now;
    }, 1000);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(probe);
      clearInterval(report);
    };
  }, []);

  return sample;
}
