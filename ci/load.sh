#!/usr/bin/env bash
# k6 부하·장애 시험. 별도 서버(8090)를 띄워 앱 E2E와 섞이지 않게 한다.
source "$(dirname "$0")/lib.sh"
OUT="$REPORTS/load"; mkdir -p "$OUT"
(cd "$ROOT/server" && PORT=8090 LOG_LEVEL=warn nohup npx tsx src/main.ts > "$OUT/server.log" 2>&1 & echo $! > "$OUT/server.pid")
trap 'pkill -P "$(cat "$OUT/server.pid")" 2>/dev/null; kill "$(cat "$OUT/server.pid")" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf localhost:8090/symbols > /dev/null && break; sleep 1; done
cd "$ROOT"
k6 run -q -e BASE=http://localhost:8090 -e DURATION=${ORDERS_DURATION:-30s} -e OUT="$OUT/orders.json" loadtest/orders.js
k6 run -q -e BASE=http://localhost:8090 -e VUS=${VUS:-1000} -e RAMP=20s -e HOLD=40s -e CHAOS_AT=40s \
  --summary-export "$OUT/ws-chaos.json" loadtest/ws-fanout.js
