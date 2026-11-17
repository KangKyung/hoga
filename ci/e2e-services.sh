#!/usr/bin/env bash
# E2E에 필요한 프로세스: 모의 서버 2대(iOS·Android — 장애 주입이 서로 섞이지 않게), Metro, Appium. up | down
# 개발할 때 띄워 둔 서버(8080)·Metro(8081)와 겹치지 않게 CI 전용 포트를 쓰고, 이미 쓰는 포트는 재사용하지 않는다
# (재사용하면 이번 커밋이 아닌 다른 코드를 시험하게 된다).
source "$(dirname "$0")/lib.sh"
# pid 파일은 reports 밖에 둔다. reports는 다음 빌드의 Prepare가 지우므로, post의 down이 돌지 못한 빌드
# (Jenkins 재시작·강제 종료)가 남긴 프로세스를 찾을 길이 없어져 이후 빌드가 모두 "포트 사용 중"으로 실패한다
RUN="${E2E_RUN_DIR:-$HOME/.hoga-ci/e2e-run}"; LOGS="$REPORTS/run"; mkdir -p "$RUN" "$LOGS"
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t > /dev/null 2>&1; }
wait_port() { for _ in $(seq 1 90); do listening "$1" && return 0; sleep 1; done; echo "port $1 not up"; exit 1; }
start() { # name port command...
  local name=$1 port=$2; shift 2
  if listening "$port"; then
    echo "$name: :$port is already in use — stop that process or change the CI port (ci/lib.sh E2E_*_PORT)" >&2
    exit 1
  fi
  (cd "$ROOT" && nohup "$@" > "$LOGS/$name.log" 2>&1 & echo "$! $port" > "$RUN/$name.pid")
  wait_port "$port"; echo "$name: up on :$port"
}
down() {
  # npx·bash 래퍼 아래의 node(손자 프로세스)까지 끝내도록 포트를 듣는 프로세스도 함께 정리
  for f in "$RUN"/*.pid; do
    [ -f "$f" ] || continue
    read -r pid port < "$f"
    kill $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$f"
  done
}
case "${1:-up}" in
  up)
    # 지난 빌드가 정리하지 못하고 남긴 CI 프로세스(pid 파일이 남아 있는 것만)를 먼저 끝낸다
    down
    sleep 1
    # Appium 드라이버(XCUITest·UiAutomator2)는 e2e/.appium 에 설치(병렬 단계보다 먼저 한 번)
    [ -d "$ROOT/e2e/.appium/node_modules/appium-xcuitest-driver" ] || (cd "$ROOT/e2e" && npm run drivers)
    start server-ios "$E2E_IOS_SERVER_PORT" env PORT="$E2E_IOS_SERVER_PORT" LOG_LEVEL=warn npx --prefix server tsx server/src/main.ts
    start server-android "$E2E_ANDROID_SERVER_PORT" env PORT="$E2E_ANDROID_SERVER_PORT" LOG_LEVEL=warn npx --prefix server tsx server/src/main.ts
    # 번들 안의 서버 주소를 CI 서버로(babel.config.js). Android는 adb reverse로 같은 주소를 자기 서버에 잇는다
    start metro "$E2E_METRO_PORT" bash -c "cd apps/mobile && HOGA_DEV_SERVER_HOST=localhost:$E2E_IOS_SERVER_PORT npx react-native start --port $E2E_METRO_PORT"
    start appium "$E2E_APPIUM_PORT" bash -c "cd e2e && APPIUM_HOME=./.appium npx appium --port $E2E_APPIUM_PORT --log-level warn"
    ;;
  down)
    down
    ;;
esac
