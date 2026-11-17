/**
 * 모의 거래소 서버 주소(server/, 기본 포트 8080).
 * iOS 시뮬레이터는 Mac의 localhost에 바로 닿는다.
 * Android 에뮬레이터는 `adb reverse tcp:8080 tcp:8080` 후 localhost로 접속한다
 * (Android 17의 로컬 네트워크 권한 없이 동작).
 * CI E2E는 개발 서버와 겹치지 않게 전용 포트의 서버를 쓰고, 그 주소를 Metro가 번들에 넣는다
 * (babel.config.js의 HOGA_DEV_SERVER_HOST). 개발 빌드에서만 쓰고 릴리스는 언제나 기본값이다.
 */
declare const process: {env: {HOGA_DEV_SERVER_HOST?: string}}; // RN이 process.env를 둔다(Node 타입은 쓰지 않는다)
const HOST = (__DEV__ && process.env.HOGA_DEV_SERVER_HOST) || 'localhost:8080';

/**
 * 시세 형식. 'bin'이면 시세(호가·체결)를 이진(wire v1)으로 받는다. 주문 알림·오류는 언제나 JSON.
 * 측정(M7): 메시지 89→21바이트(데이터 −71%), C++ 수신 처리 1.13→0.08µs/건. 서버 CPU는 같다.
 * 디버깅 때 프록시에서 시세를 눈으로 보려면 'json'으로 바꾼다(C++가 두 형식을 모두 읽는다).
 */
export const MARKET_WIRE: 'json' | 'bin' = 'bin';

export const SERVER = {
  ws: `ws://${HOST}/ws${MARKET_WIRE === 'bin' ? '?proto=bin' : ''}`,
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
