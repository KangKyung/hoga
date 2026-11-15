# Hoga — Mini MTS

C++ 엔진 하나를 **iOS · Android · Node 서버**가 함께 쓰는 작은 모바일 트레이딩 시스템(MTS) 개인 프로젝트입니다.
앱 셸은 React Native(New Architecture), 공용 로직은 C++20, 서버는 Node.js입니다.

> 모의 데이터만 사용합니다. 실제 증권사·거래소의 이름, 상표, 화면 디자인, 시세 데이터는 쓰지 않습니다.

## 현재 단계: M0 — 빌드 체계

목표: **같은 C++ 함수가 세 곳에서 같은 값을 낸다.** → 확인 완료 (2026-11-15)

| 실행 환경 | 연결 방식 | 확인 결과 |
|---|---|---|
| 단독 (C++) | CMake + GoogleTest | `ctest` 3개 통과 |
| Node.js 25 | N-API 애드온 (`node-addon-api` + `cmake-js`) | `npm test` 3개 통과 |
| iOS 26.4 (iPhone 17 Pro 시뮬레이터) | C++ TurboModule, Objective-C++ 모듈 제공자, CocoaPods 로컬 Pod | 화면 값 일치 · [캡처](docs/m0-ios.png) |
| Android 17 / API 37 (Pixel 9 에뮬레이터) | C++ TurboModule, `OnLoad.cpp` `cxxModuleProvider`, NDK CMake | 화면 값 일치 · [캡처](docs/m0-android.png) |
| JS 단위 테스트 | Jest (TurboModule 목) | 1개 통과, `tsc` 통과 |

네 곳 모두 호가단위 12개 경계값이 같고, 소수 가격(`1000.5`)은 같은 오류(`price must be a safe integer`)로 거부합니다.

## 구조

```
hoga/
├─ core/                       # C++20 공용 코어 (CMake, GoogleTest)
│  ├─ include/hoga/core.hpp
│  ├─ src/core.cpp
│  └─ tests/
├─ bindings/
│  ├─ node/                    # Node N-API 애드온 → 서버에서 사용
│  └─ turbomodule/             # RN C++ TurboModule (iOS·Android 공용 구현 1벌)
│     └─ ios/HogaCoreModuleProvider.mm
├─ apps/mobile/                # React Native 0.88 앱
│  ├─ specs/NativeHogaCore.ts  # Codegen 스펙
│  ├─ ios/Podfile              # pod 'HogaNative', :path => '../../..'
│  └─ android/app/src/main/jni/ (CMakeLists.txt, OnLoad.cpp)
└─ HogaNative.podspec          # iOS: core + turbomodule 소스를 컴파일
```

### 호출 경로

```
JS (App.tsx)
  └─ NativeHogaCore.tickSize(price)        ← specs/NativeHogaCore.ts (Codegen)
       └─ JSI → NativeHogaCore (C++)         ← bindings/turbomodule (iOS·Android 공용)
            └─ hoga::tickSize(price)         ← core/ (서버도 같은 코드를 N-API로 호출)
```

## 실행

필요 도구: Xcode 26+, CocoaPods, Node 22+, JDK 17, Android SDK + NDK 27, CMake 3.22+
(CMake가 PATH에 없으면 Android SDK에 포함된 것을 쓸 수 있습니다: `export PATH="$HOME/Library/Android/sdk/cmake/3.22.1/bin:$PATH"`)

```bash
# 1) C++ 코어 테스트
cmake -S core -B core/build -G Ninja && cmake --build core/build && ctest --test-dir core/build

# 2) Node 애드온
cd bindings/node && npm install && npx cmake-js compile -G Ninja && npm test

# 3) 앱
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

- **가격은 정수(원)**. JS `number`가 정확히 표현하는 범위(2^53−1)를 넘거나 소수면 Node·앱 바인딩 모두 오류를 던집니다. 입력 규칙도 두 바인딩이 같습니다.
- **C++ TurboModule을 앱 안에 둔 이유**: 라이브러리로 분리하면 autolinking 설정이 늘어나므로, M0에서는 RN 공식 "Cross-Platform Native Modules (C++)" 방식대로 앱에 직접 등록했습니다. 모듈이 늘어나면 패키지로 분리할 계획입니다.
- **iOS는 로컬 Pod**: Xcode 프로젝트 파일을 직접 고치지 않고 `HogaNative.podspec`으로 소스를 포함해, Android CMake와 같은 "소스 목록 한 곳" 구조를 유지합니다.

## 알려진 한계 / 다음 단계

- 호가가격단위 표는 M1에서 KRX 규정 원문으로 다시 확인하고 출처를 남깁니다.
- 워크스페이스(모노레포 패키지 매니저)는 아직 쓰지 않습니다. RN Metro의 의존성 끌어올리기 문제를 피하려고 패키지마다 따로 설치합니다.
- 다음: M1 — OrderBook · SeqSync · 주문 검증 · 매칭 엔진, Node 시세 서버.
