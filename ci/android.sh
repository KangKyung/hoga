#!/usr/bin/env bash
# Android: 앱 모듈 lint(서드파티 모듈 제외) · Debug APK(arm64, 에뮬레이터용)
source "$(dirname "$0")/lib.sh"
export JAVA_HOME="${ANDROID_JAVA_HOME:-$(/usr/libexec/java_home -v 17)}"
cd "$ROOT/apps/mobile/android"
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew --no-daemon :app:lintDebug assembleDebug \
  -PreactNativeArchitectures=arm64-v8a -Preact.internal.mavenLocalRepo="$RN_MAVEN_MIRROR"
mkdir -p "$REPORTS/android"
cp app/build/reports/lint-results-debug.* "$REPORTS/android/" 2>/dev/null || true
