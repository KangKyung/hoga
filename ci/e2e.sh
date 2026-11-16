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
  # 앱은 localhost:8080(서버)·8081(Metro)로 접속 → 이 플랫폼 전용 서버 8091로 돌린다
  adb -s "$serial" reverse tcp:8080 tcp:8091
  adb -s "$serial" reverse tcp:8081 tcp:8081
  # Android 17: 10.0.2.2(Metro 기본)는 로컬 네트워크 권한이 필요 → adb reverse 경로(localhost:8081)를 쓰게 한다
  adb -s "$serial" shell am force-stop com.hogaapp
  printf '%s' "<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name=\"debug_http_host\">localhost:8081</string></map>" |
    adb -s "$serial" shell "run-as com.hogaapp sh -c 'mkdir -p shared_prefs && cat > shared_prefs/com.hogaapp_preferences.xml'"
  export ANDROID_DEVICE=$serial HOGA_SERVER=http://localhost:8091
else
  app="$ROOT/apps/mobile/ios/build/dd/Build/Products/Debug-iphonesimulator/HogaApp.app"
  udid=${IOS_UDID:-$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=[x for v in json.load(sys.stdin)["devices"].values() for x in v]; print(d[0]["udid"] if d else "")')}
  [ -n "$udid" ] || { echo "no booted iOS simulator"; exit 1; }
  xcrun simctl install "$udid" "$app"
  export IOS_UDID=$udid HOGA_SERVER=http://localhost:8080
fi
PLATFORM=$platform npx wdio run wdio.conf.ts --spec "$spec"
mkdir -p "$REPORTS/junit" && cp reports/"$platform"/*.xml "$REPORTS/junit/" 2>/dev/null || true
