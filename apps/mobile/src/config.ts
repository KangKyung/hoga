/**
 * 모의 거래소 서버 주소(server/, 기본 포트 8080).
 * iOS 시뮬레이터는 Mac의 localhost에 바로 닿는다.
 * Android 에뮬레이터는 `adb reverse tcp:8080 tcp:8080` 후 localhost로 접속한다
 * (Android 17의 로컬 네트워크 권한 없이 동작).
 */
const HOST = 'localhost:8080';

export const SERVER = {
  ws: `ws://${HOST}/ws`,
  http: `http://${HOST}`,
};

/** 화면 갱신 주기. 사람 눈보다 빠를 필요가 없어 초당 12회로 묶는다. */
export const BOOK_REFRESH_HZ = 12;
/** 이 시간 동안 호가가 안 바뀌면 "지연" 표시 */
export const STALE_AFTER_MS = 3_000;
