#!/usr/bin/env bash
# Appium E2E (WebdriverIO 한 벌). 사용: ci/e2e.sh ios|android [spec]
# 시뮬레이터/에뮬레이터는 미리 켜 둔다(IOS_UDID, ANDROID_SERIAL로 고를 수 있다).
source "$(dirname "$0")/lib.sh"
platform=$1; spec=${2:-specs/flows.e2e.ts}
cd "$ROOT/e2e"
if [ "$platform" = android ]; then
  serial=${ANDROID_SERIAL:-emulator-5554}
  apk="$ROOT/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
  adb -s "$serial" install -r "$apk" > /dev/null
  # 번들의 서버 주소(localhost:$E2E_IOS_SERVER_PORT)를 이 플랫폼 전용 서버로 돌리고, Metro도 CI 것으로
  adb -s "$serial" reverse tcp:"$E2E_IOS_SERVER_PORT" tcp:"$E2E_ANDROID_SERVER_PORT"
  adb -s "$serial" reverse tcp:"$E2E_METRO_PORT" tcp:"$E2E_METRO_PORT"
  # Android 17: 10.0.2.2(Metro 기본)는 로컬 네트워크 권한이 필요 → adb reverse 경로(localhost)를 쓰게 한다
  set_metro_host() {
    adb -s "$serial" shell am force-stop com.hogaapp
    printf '%s' "<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name=\"debug_http_host\">$1</string></map>" |
      adb -s "$serial" shell "run-as com.hogaapp sh -c 'mkdir -p shared_prefs && cat > shared_prefs/com.hogaapp_preferences.xml'"
  }
  # 끝나면(실패해도) 개발할 때 쓰는 Metro(localhost:8081)로 되돌리고 CI 포트 연결을 푼다.
  # 그대로 두면 빌드 뒤 에뮬레이터의 개발용 앱이 꺼진 CI Metro를 가리켜 번들을 못 받는다
  restore_dev() {
    set_metro_host localhost:8081 || true
    adb -s "$serial" reverse --remove tcp:"$E2E_IOS_SERVER_PORT" 2>/dev/null || true
    adb -s "$serial" reverse --remove tcp:"$E2E_METRO_PORT" 2>/dev/null || true
  }
  trap restore_dev EXIT
  set_metro_host "localhost:$E2E_METRO_PORT"
  export ANDROID_DEVICE=$serial HOGA_SERVER=http://localhost:$E2E_ANDROID_SERVER_PORT
else
  app="$ROOT/apps/mobile/ios/build/dd/Build/Products/Debug-iphonesimulator/HogaApp.app"
  udid=${IOS_UDID:-$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=[x for v in json.load(sys.stdin)["devices"].values() for x in v]; print(d[0]["udid"] if d else "")')}
  [ -n "$udid" ] || { echo "no booted iOS simulator"; exit 1; }
  xcrun simctl install "$udid" "$app"
  # Metro 주소는 실행 인자로(RN이 NSUserDefaults의 RCT_jsLocation을 읽는다)
  export IOS_UDID=$udid HOGA_SERVER=http://localhost:$E2E_IOS_SERVER_PORT IOS_JS_LOCATION=localhost:$E2E_METRO_PORT
fi
APPIUM_PORT=$E2E_APPIUM_PORT PLATFORM=$platform npx wdio run wdio.conf.ts --spec "$spec"
mkdir -p "$REPORTS/junit" && cp reports/"$platform"/*.xml "$REPORTS/junit/" 2>/dev/null || true
