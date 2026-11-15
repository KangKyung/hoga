# Hoga — Mini MTS

C++ 엔진 하나를 **iOS · Android · Node 서버**가 함께 쓰는 작은 모바일 트레이딩 시스템(MTS) 개인 프로젝트입니다.
앱 셸은 React Native(New Architecture), 공용 로직은 C++20, 서버는 Node.js입니다.

> 모의 데이터만 사용합니다. 실제 증권사·거래소의 이름, 상표, 화면 디자인, 시세 데이터는 쓰지 않습니다.

## 진행 상황

| 단계 | 내용 | 상태 |
|---|---|---|
| M0 | 같은 C++ 함수를 C++ · Node · iOS · Android에서 호출 | 완료 |
| **M1** | C++ 호가·재동기화·주문 검증·매칭 엔진 + Node 모의 거래소 서버 | **완료** |
| M2 | 앱 실시간 호가 (C++ TurboModule + 플랫폼 소켓, JNI · Obj-C++) | 다음 |

### M1 검증 결과 (2026-11-15)

| 대상 | 내용 | 결과 |
|---|---|---|
| C++ 코어 | GoogleTest 37개 | 일반 · ASan+UBSan · TSan 빌드 모두 통과, `-Wconversion -Wshadow` 경고 없음 |
| Node 애드온 | node:test 7개 (매칭 엔진·검증 규칙을 C++에서 그대로 호출) | 통과 |
| 서버 | vitest 20개 (단위 + 실제 포트를 여는 통합 테스트) | 3회 연속 통과, `tsc` 통과 |
| 서버 실제 실행 | 2초 동안 2종목 구독 → 변경분 43개, seq 누락 0, SIGTERM 정상 종료 | 확인 |

### M0 검증 결과

| 실행 환경 | 연결 방식 | 확인 결과 |
|---|---|---|
| iOS 26.4 (iPhone 17 Pro 시뮬레이터) | C++ TurboModule, Objective-C++ 모듈 제공자, CocoaPods 로컬 Pod | 화면 값 일치 · [캡처](docs/m0-ios.png) |
| Android 17 / API 37 (Pixel 9 에뮬레이터) | C++ TurboModule, `OnLoad.cpp` `cxxModuleProvider`, NDK CMake | 화면 값 일치 · [캡처](docs/m0-android.png) |

## 구조

```
hoga/
├─ core/                          # C++20 공용 코어 (CMake, GoogleTest, Sanitizer)
│  ├─ include/hoga/
│  │  ├─ core.hpp                 # 호가단위 · 호가단위 맞춤 · 가격제한폭
│  │  ├─ order_book.hpp           # L2 호가창 (단일 작성자 + 다중 읽기, shared_mutex)
│  │  ├─ book_sync.hpp            # seq 기반 스냅샷 + 변경분 재동기화 상태 머신
│  │  ├─ order.hpp                # 주문 검증 (앱·서버 공용 규칙)
│  │  └─ matching_engine.hpp      # 가격·시간 우선 매칭 엔진
│  └─ tests/
├─ bindings/
│  ├─ node/                       # N-API 애드온 → 서버가 매칭·검증에 사용
│  └─ turbomodule/                # RN C++ TurboModule (iOS·Android 공용 구현 1벌)
├─ server/                        # Node.js 모의 거래소 (TypeScript, Fastify, ws)
│  ├─ src/market/                 # 시세 단일 작성자 + 모의 주문 발생기
│  ├─ src/gateway/                # WebSocket 팬아웃 (백프레셔·하트비트·제한)
│  ├─ src/api/                    # REST 주문 (멱등 키)
│  ├─ src/bus.ts                  # 메시지 전달 계층 인터페이스 (메모리 구현, Redis는 M6)
│  └─ test/
├─ apps/mobile/                   # React Native 0.88 앱
└─ HogaNative.podspec             # iOS: core + turbomodule 소스를 컴파일
```

## 서버 (모의 거래소)

```
            REST 주문 (Idempotency-Key)                     WebSocket /ws
 client ──────────────────────────────▶ api ─┐        ┌──────────────────────▶ client
                                             ▼        │ 구독 직후 스냅샷,
                                   market (단일 작성자) │ 이후 seq+1 변경분
                                   MatchingEngine(C++) │
                                   종목별 seq 발급      │
                                             │        │
                                             └─▶ bus ─┴─▶ gateway (상태 없음, 여러 대 가능)
```

```bash
cd server && npm install
npm start                                   # http://localhost:8080, ws://localhost:8080/ws
FAULT_DROP_SEQ_RATE=0.02 npm start          # 변경분 2%를 일부러 빠뜨림 → 앱 재동기화 시연
FAULT_ORDER_DELAY_MS=5000 npm start         # 주문은 처리하고 응답만 5초 늦춤 → 타임아웃 후 조회 시연
npm test
```

| 엔드포인트 | 설명 |
|---|---|
| `GET /healthz`, `/readyz`, `/metrics` | 상태 · Prometheus 지표 |
| `GET /symbols` | 모의 종목 목록 (기준가, 호가단위, 상·하한가) |
| `GET /book/:symbol?depth=20` | 스냅샷 (재동기화용) |
| `POST /orders` | 주문. `Idempotency-Key` 헤더 필수 |
| `GET /orders/:key` | 주문 결과 조회 (타임아웃 후 확정용) |
| `POST /orders/:key/cancel` | 대기 주문 취소 |

### 시세 프로토콜

```jsonc
// 클라이언트 → 서버
{ "op": "sub", "symbols": ["000001"] }
// 서버 → 클라이언트
{ "t": "snap",  "sym": "000001", "seq": 1042, "bids": [[71200, 1520]], "asks": [[71300, 880]], "ts": 0 }
{ "t": "delta", "sym": "000001", "seq": 1043, "side": "B", "px": 71200, "qty": 1490, "ts": 0 }  // qty 0 = 삭제
{ "t": "trade", "sym": "000001", "px": 71300, "qty": 12, "aggr": "B", "ts": 0 }                  // 정보용, seq 없음
```

- 종목별 seq는 변경분마다 1씩 증가합니다. 클라이언트는 `seq == last + 1`일 때만 반영하고, 건너뛰면 `GET /book/:symbol`로 다시 맞춥니다(`hoga::BookSync`).
- 변경분의 `qty`는 증감량이 아니라 **그 가격대의 새 잔량**이라, 같은 메시지를 두 번 받아도 결과가 같습니다.

### 주문 — 한 번만, 결과는 반드시 확정

| 상황 | 응답 |
|---|---|
| 처음 보는 키 | 처리 후 결과 저장 → 200 |
| 같은 키 + 같은 내용 (재전송) | 다시 처리하지 않고 처음 결과 → 200, `Idempotent-Replayed: true` |
| 같은 키 + 처리 중 | 409 → 잠시 후 `GET /orders/:key` |
| 같은 키 + 다른 내용 | 422 (키 재사용 버그 방지) |
| 형식 오류 | 400 |
| 호가단위·가격제한폭 등 규칙 위반 | 200 + `status: REJECTED`, `reject: OFF_TICK` 등 (업무 거부) |

### 많은 동시 접속을 버티는 장치 (gateway)

| 문제 | 장치 |
|---|---|
| 느린 클라이언트가 서버 메모리를 잡아먹음 | 송신 버퍼가 SOFT(512KB)를 넘으면 그 종목 변경분을 건너뛰고, 버퍼가 비면 **최신 스냅샷 1개**로 따라잡게 함. HARD(1MB) 초과 시 1013으로 종료 |
| 죽은 연결이 쌓임 | 15초 하트비트 ping, 다음 주기까지 pong 없으면 terminate |
| 남용 | 메시지 4KB 제한, 연결당 초당 20개(토큰 버킷), 연결당 구독 20종목 |
| 재시작 때 일제히 재접속 | 종료 시 1012(서비스 재시작) 전송 → 클라이언트는 지터를 둔 백오프로 흩어져 재접속(M2) |
| 구독자마다 직렬화 | market이 한 번 직렬화한 문자열을 그대로 전송 |

## 실행 (전체)

필요 도구: Xcode 26+, CocoaPods, Node 22+, JDK 17, Android SDK + NDK 27, CMake 3.22+
(CMake가 PATH에 없으면 Android SDK에 포함된 것을 쓸 수 있습니다: `export PATH="$HOME/Library/Android/sdk/cmake/3.22.1/bin:$PATH"`)

```bash
# 1) C++ 코어 테스트 (Sanitizer: -DHOGA_SANITIZE=address | thread | undefined)
cmake -S core -B core/build -G Ninja && cmake --build core/build && ctest --test-dir core/build

# 2) Node 애드온
cd bindings/node && npm install && npx cmake-js compile -G Ninja && npm test

# 3) 서버
cd server && npm install && npm test && npm start

# 4) 앱
cd apps/mobile && npm install
(cd ios && pod install) && npx react-native run-ios
npx react-native run-android --active-arch-only
```

### 느린 네트워크에서 설치하기

RN 사전 빌드 파일 저장소(`repo.reactnative.dev`)와의 연결이 중간에 거의 멈추는 경우가 있습니다. CocoaPods와 Gradle은 느린 연결을 끊지 않고 계속 기다리므로, 멈춘 듯하면 파일을 직접 받아 로컬 경로를 지정합니다.

```bash
# 공통: 느려지면 끊고 이어받기
curl -fL -C - --retry 40 --retry-all-errors --speed-limit 30000 --speed-time 15 -o <파일> <URL>
```

- **iOS**: `ios/Pods/*-artifacts/`에 파일을 미리 두고 아래처럼 실행
  ```bash
  RCT_TESTONLY_RNCORE_TARBALL_PATH=$PWD/Pods/ReactNativeCore-artifacts/reactnative-core-0.88.1-debug.tar.gz \
  RCT_USE_LOCAL_RN_DEP=$PWD/Pods/ReactNativeDependencies-artifacts/reactnative-dependencies-0.88.1-debug.tar.gz \
  pod install
  ```
- **Android**: `react-android-0.88.1-debug.aar`(+ `.pom`, `.module`)을 Maven 구조의 로컬 폴더에 두고
  ```bash
  ./gradlew app:assembleDebug -PreactNativeArchitectures=arm64-v8a -Preact.internal.mavenLocalRepo=$HOME/.m2/rn-mirror
  ```
  받은 파일은 `.module`에 적힌 SHA-1과 비교해 확인합니다.
- **Android 17 에뮬레이터**: 디버그 앱이 Metro(`10.0.2.2`)에 붙을 때 로컬 네트워크 권한을 요청합니다. 권한 대신 `adb reverse tcp:8081 tcp:8081` 후 개발 메뉴의 서버 주소를 `localhost:8081`로 지정해도 됩니다.

## 설계 메모

- **가격·수량은 정수(원·주)**. JS `number`가 정확히 표현하는 범위(2^53−1)를 넘거나 소수면 Node·앱 바인딩 모두 오류를 던집니다.
- **규칙은 한 곳에만**: 호가단위, 가격제한폭, 주문 검증은 C++ 한 벌을 앱(TurboModule)과 서버(N-API)가 함께 씁니다.
- **시세 단일 작성자**: 한 종목의 seq를 여러 곳에서 발급하면 순서가 꼬이므로 market만 발급합니다. 부하의 대부분인 팬아웃은 상태 없는 gateway를 늘려 감당합니다.
- **매칭 엔진은 결정적**: 같은 입력이면 같은 출력. 한 스레드(Node 이벤트 루프)에서만 호출합니다.
- **`OrderBook`은 쓰기 1 · 읽기 다수**: 소켓 스레드가 쓰고 JS·UI 스레드가 읽는 M2 구조를 위해 `shared_mutex`로 보호하고, TSan으로 확인합니다.
- **C++ TurboModule을 앱 안에 둔 이유**: RN 공식 "Cross-Platform Native Modules (C++)" 방식. 모듈이 늘어나면 패키지로 분리합니다.
- **iOS는 로컬 Pod**: Xcode 프로젝트 파일을 직접 고치지 않고 `HogaNative.podspec`으로 소스를 포함합니다.

## 알려진 한계 / 다음 단계

- 호가가격단위 · 가격제한폭은 **간소화한 규칙**입니다. KRX 규정 원문과 대조하고 출처를 남겨야 합니다.
- 서버의 버스·멱등 저장소는 메모리 구현만 있습니다. 여러 프로세스 확장(Redis Pub/Sub, `SET NX`)은 M6에서 붙입니다.
- 인증이 없어 누구나 남의 주문 키로 조회·취소할 수 있습니다(M3에서 JWT 추가).
- 체결 메시지에는 seq가 없어 끊기면 유실될 수 있습니다(정보용으로만 사용).
- 다음: **M2** — 앱이 서버에 붙어 실시간 호가를 표시. 소켓은 iOS `URLSession`(Obj-C++) / Android `OkHttp`(Kotlin + JNI)로 받고, C++ `BookSync`가 재동기화를 맡습니다.
