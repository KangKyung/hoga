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

/** 주문 응답 제한 시간. 넘으면 실패가 아니라 "확인 중"으로 넘어가 조회로 확정한다. */
export const ORDER_TIMEOUT_MS = 3_000;

/**
 * 민감 화면 보호(Android FLAG_SECURE, iOS 앱 전환기 가림). 기본 켜짐.
 * 화면 캡처로 검증할 때만 로컬에서 잠시 끈다(커밋하지 않는다).
 */
export const SECURE_SCREEN = true;
