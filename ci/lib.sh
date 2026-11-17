# CI 공용 환경. Jenkins와 로컬 터미널에서 같은 스크립트를 쓴다.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/cmake/3.22.1/bin:$ANDROID_HOME/platform-tools:/opt/homebrew/bin:$PATH"
export LANG="${LANG:-en_US.UTF-8}"
# RN 사전 빌드 파일(느린 저장소 대비, README "느린 네트워크에서 설치하기")
export RN_ARTIFACTS="${RN_ARTIFACTS:-$HOME/.hoga-ci/rn-artifacts}"
export RN_MAVEN_MIRROR="${RN_MAVEN_MIRROR:-$HOME/.m2/rn-mirror}"
REPORTS="$ROOT/reports"
mkdir -p "$REPORTS/junit"
# E2E 전용 포트(개발용 서버 8080 · Metro 8081 · Appium 4723과 겹치지 않게)
export E2E_IOS_SERVER_PORT="${E2E_IOS_SERVER_PORT:-18080}"
export E2E_ANDROID_SERVER_PORT="${E2E_ANDROID_SERVER_PORT:-18091}"
export E2E_METRO_PORT="${E2E_METRO_PORT:-18081}"
export E2E_APPIUM_PORT="${E2E_APPIUM_PORT:-14723}"
