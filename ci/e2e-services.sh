#!/usr/bin/env bash
# E2E에 필요한 프로세스: 모의 서버 2대(iOS 8080, Android 8091 — 장애 주입이 서로 섞이지 않게),
# Metro(8081), Appium(4723). up | down
source "$(dirname "$0")/lib.sh"
RUN="$REPORTS/run"; mkdir -p "$RUN"
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t > /dev/null 2>&1; }
wait_port() { for _ in $(seq 1 90); do listening "$1" && return 0; sleep 1; done; echo "port $1 not up"; exit 1; }
start() { # name port command...
  local name=$1 port=$2; shift 2
  if listening "$port"; then echo "$name: :$port already running (reuse)"; return; fi
  (cd "$ROOT" && nohup "$@" > "$RUN/$name.log" 2>&1 & echo "$! $port" > "$RUN/$name.pid")
  wait_port "$port"; echo "$name: up on :$port"
}
case "${1:-up}" in
  up)
    # Appium 드라이버(XCUITest·UiAutomator2)는 e2e/.appium 에 설치(병렬 단계보다 먼저 한 번)
    [ -d "$ROOT/e2e/.appium/node_modules/appium-xcuitest-driver" ] || (cd "$ROOT/e2e" && npm run drivers)
    start server-ios 8080 env PORT=8080 LOG_LEVEL=warn npx --prefix server tsx server/src/main.ts
    start server-android 8091 env PORT=8091 LOG_LEVEL=warn npx --prefix server tsx server/src/main.ts
    start metro 8081 bash -c "cd apps/mobile && npx react-native start --port 8081"
    start appium 4723 bash -c "cd e2e && APPIUM_HOME=./.appium npx appium --port 4723 --log-level warn"
    ;;
  down)
    # npx·bash 래퍼 아래의 node(손자 프로세스)까지 끝내도록 포트를 듣는 프로세스도 함께 정리
    for f in "$RUN"/*.pid; do
      [ -f "$f" ] || continue
      read -r pid port < "$f"
      kill $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      rm -f "$f"
    done
    ;;
esac
