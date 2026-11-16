#!/usr/bin/env bash
# 로컬 클러스터: Redis + market 1 + gateway N + nginx(앞단, 기본 8080 — 앱이 그대로 접속).
#   deploy/cluster.sh up [N=3]   |   deploy/cluster.sh down   |   deploy/cluster.sh kill-gateway <i>   |   status
# 실행 파일·로그는 ~/.hoga-ci/cluster 에 둔다. 8100은 iOS Appium(WebDriverAgent)이 써서 market은 8200부터.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${HOGA_CLUSTER_DIR:-$HOME/.hoga-ci/cluster}"
PORT="${PORT:-8080}"
MARKET_PORT="${MARKET_PORT:-8200}"
GW_BASE="${GW_BASE:-8201}"
REDIS_PORT="${REDIS_PORT:-6380}"
export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
mkdir -p "$RUN/tmp"

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t > /dev/null 2>&1; }
wait_port() { for _ in $(seq 1 60); do listening "$1" && return 0; sleep 0.5; done; echo "port $1 not up" >&2; exit 1; }
node_server() { # name port env...
  local name=$1 port=$2; shift 2
  listening "$port" && { echo ":$port is busy ($name)" >&2; exit 1; }
  # exec로 서브셸을 node로 바꿔 $!가 node의 pid가 되게 한다(kill-gateway가 실제 프로세스를 죽이도록)
  (cd "$ROOT/server" && exec env "$@" PORT="$port" LOG_LEVEL="${LOG_LEVEL:-warn}" node --import tsx src/main.ts) > "$RUN/$name.log" 2>&1 &
  echo $! > "$RUN/$name.pid"
  wait_port "$port"
}

up() {
  local n=${1:-3}
  listening "$PORT" && { echo ":$PORT is busy (stop the dev server first)" >&2; exit 1; }
  redis-server --port "$REDIS_PORT" --save '' --appendonly no --daemonize yes --pidfile "$RUN/redis.pid" --logfile "$RUN/redis.log"
  wait_port "$REDIS_PORT"
  node_server market "$MARKET_PORT" ROLE=market TRUST_PROXY=127.0.0.1
  : > "$RUN/upstream.conf"
  for i in $(seq 1 "$n"); do
    local p=$((GW_BASE + i - 1))
    node_server "gateway-$i" "$p" ROLE=gateway MARKET_URL="http://127.0.0.1:$MARKET_PORT" GATEWAY_ID="gw-$i"
    echo "    server 127.0.0.1:$p max_fails=3 fail_timeout=2s;" >> "$RUN/upstream.conf"
  done
  sed -e "s|__RUN__|$RUN|g" -e "s|__PORT__|$PORT|g" -e "s|__MARKET_PORT__|$MARKET_PORT|g" \
    -e "/__GATEWAYS__/{r $RUN/upstream.conf" -e "d;}" "$ROOT/deploy/nginx.conf.template" > "$RUN/nginx.conf"
  nginx -p "$RUN" -c "$RUN/nginx.conf"
  wait_port "$PORT"
  echo "cluster up: nginx :$PORT → market :$MARKET_PORT + $n gateways (:$GW_BASE..), redis :$REDIS_PORT"
}

stop_pid() { # SIGTERM(1012로 정상 종료) → 5초 안에 안 끝나면 SIGKILL
  local pid=$1
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
}

down() {
  [ -f "$RUN/nginx.pid" ] && nginx -p "$RUN" -c "$RUN/nginx.conf" -s quit 2>/dev/null || true
  # gateway → market → Redis 순서(Redis를 먼저 끄면 종료 처리가 Redis를 기다린다)
  for f in "$RUN"/gateway-*.pid "$RUN"/market.pid; do
    [ -f "$f" ] || continue; stop_pid "$(cat "$f")"; rm -f "$f"
  done
  redis-cli -p "$REDIS_PORT" shutdown nosave > /dev/null 2>&1 || true
  rm -f "$RUN/redis.pid"
  echo "cluster down"
}

case "${1:-status}" in
  up) trap 'echo "up failed → cleaning up" >&2; down' ERR; up "${2:-3}" ;;
  down) down ;;
  # 장애 시험: gateway 하나를 SIGKILL(정상 종료 없이) → 그 연결들은 1006으로 끊긴다
  kill-gateway) kill -9 "$(cat "$RUN/gateway-${2:-1}.pid")" && rm -f "$RUN/gateway-${2:-1}.pid" && echo "killed gateway-${2:-1}" ;;
  # k6가 gateway에 직접 나눠 붙을 주소 목록(맥 한 대에서 nginx를 거치면 연결마다 임시 포트를 두 개 써서 1만 연결 전에 바닥난다)
  ws-urls) for f in "$RUN"/gateway-*.pid; do i=${f##*gateway-}; i=${i%.pid}; printf "ws://127.0.0.1:%s/ws," $((GW_BASE + i - 1)); done | sed 's/,$//'; echo ;;
  status) curl -s "http://127.0.0.1:$PORT/readyz"; echo; for f in "$RUN"/gateway-*.pid; do [ -f "$f" ] && echo "$(basename "$f" .pid) pid $(cat "$f")"; done ;;
esac
