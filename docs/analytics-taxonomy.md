# 분석 이벤트 분류표 (앱 · 웹 공용)

정의 파일: [`shared/analytics/events.json`](../shared/analytics/events.json) — 앱(RN)과 웹 화면(종목정보·공지)이 같은 파일을 읽는다.
이 문서는 그 파일을 사람이 읽기 좋게 풀어 쓴 것이다. **이름·매개변수를 바꿀 때는 JSON을 먼저 고친다.** 테스트가 둘 사이를 검사한다.

## 원칙

| 원칙 | 이유 |
|---|---|
| 이름은 GA4 규칙: 소문자 `snake_case`, 40자 이하, `firebase_`·`google_`·`ga_`로 시작하지 않음 | Firebase Analytics·GA4가 그대로 받는다 |
| 앱과 웹이 **같은 이름**을 쓴다 (`screen_view` 등) | 앱 화면이 웹뷰로 바뀌어도 보고서가 끊기지 않는다 |
| 개인정보·금액·수량은 보내지 않는다 | 금융 앱. 주문은 종목·방향·종류·결과만 |
| 분류표에 없는 매개변수는 버린다 | 웹 화면(신뢰하지 않는 입력)이 아무 값이나 실어 보내지 못하게 |
| 웹뷰 안의 웹 이벤트는 앱으로 넘겨 **한 파이프라인으로만** 보낸다 | 웹 GTM과 앱 Firebase가 같은 클릭을 두 번 세지 않게 |

## 전송 경로

```
앱 화면 ──track()──────────────────────────────┐
                                                ├─▶ 싱크들 ─▶ (Firebase Analytics: 계정 연결 시)
웹뷰 안 웹 화면 ─HogaAnalytics.track()─▶ 브리지 ─┘        └─▶ 디버그 싱크(설정 화면 목록)
   └ 매개변수를 분류표로 거르고 source=web

일반 브라우저의 웹 화면 ─HogaAnalytics.track()─▶ dataLayer ─▶ GTM(컨테이너 ID 설정 시) ─▶ GA4
```

- GTM은 서버 환경 변수 `GTM_CONTAINER_ID`가 있을 때만 불러온다. 없으면 `dataLayer`에만 쌓는다.
- Content-Security-Policy는 GTM을 설정했을 때만 `www.googletagmanager.com`을 허용한다.
- Firebase·GA4·GTM 계정은 이 저장소에 없다. 앱은 `setSinks()`로 Firebase 싱크를 꽂으면 된다.

## 이벤트

| 이벤트 | 보내는 곳 | 매개변수 | 언제 |
|---|---|---|---|
| `login` | 앱 | `method`(password·biometric), `lock_enabled` | 로그인 성공 |
| `screen_view` | 앱·웹 | `screen_name`(watchlist·quote·settings·bench·notices / stock_info·notice_detail) | 화면 진입 |
| `select_symbol` | 앱 | `symbol` | 관심종목에서 종목 선택 |
| `switch_quote_tab` | 앱 | `symbol`, `tab`(book·chart·info) | 호가·차트·정보 탭 전환 |
| `change_chart_interval` | 앱 | `symbol`, `interval`(1m·5m) | 차트 봉 간격 변경 |
| `open_order_sheet` | 앱 | `symbol`, `side`, `entry`(book·button·web) | 주문 창 열기. `entry=web`이면 웹 화면 버튼에서 연 것 |
| `submit_order` | 앱 | `symbol`, `side`, `order_type` | 주문 버튼(금액·수량 없음) |
| `order_result` | 앱 | `symbol`, `result`, `confirmed_by_lookup` | 결과 확정. 타임아웃 뒤 조회로 확정됐으면 `confirmed_by_lookup=true` |
| `view_stock_info` | 웹 | `symbol`, `in_app` | 종목정보 웹 화면 표시 |
| `click_order_from_web` | 웹 | `symbol`, `side` | 웹 화면의 매수·매도 버튼 |
| `view_notice` | 웹 | `notice_id`, `category` | 공지 상세 |
| `filter_notices` | 웹 | `category` | 공지 분류 선택 |
| `change_language` | 앱 | `from`, `to` | 언어 변경 |
| `bridge_rejected` | 앱 | `reason`(origin·schema·version·size·rate), `type` | 웹뷰 브리지가 메시지를 거절 — 보안·호환성 모니터링용 |

## 이 분류표로 답할 수 있는 질문 (예)

- 웹 화면에서 연 주문 창이 실제 주문으로 이어지는 비율: `open_order_sheet(entry=web)` → `submit_order`
- 서버 지연 때 주문이 얼마나 "확인 중"을 거쳐 확정되는지: `order_result(confirmed_by_lookup=true)` 비율
- 언어별 이용: `change_language`, 사용자 속성(언어)과 결합
- 웹 화면 배포 후 앱과 프로토콜이 어긋났는지: `bridge_rejected(reason=version)` 급증

## 검사

- 앱 Jest(`__tests__/web.test.ts`): 이름 규칙, 알 수 없는 이벤트·매개변수·보내는 곳 검사, **웹 JS가 보내는 이벤트가 모두 분류표에 web으로 등록돼 있는지**
- 앱 Jest(`__tests__/App.test.tsx`): 웹이 보낸 분류표 밖 매개변수(`email`)가 버려지는지
- 개발 중: 앱은 `console.warn`, 웹은 콘솔 경고로 분류표 위반을 바로 보여 준다
