#!/usr/bin/env bash
# 의존성 설치(병렬 단계들이 같은 node_modules를 동시에 만지지 않도록 먼저 한 번에)
source "$(dirname "$0")/lib.sh"
for dir in bindings/node server apps/mobile e2e; do
  echo "== npm ci: $dir"
  (cd "$ROOT/$dir" && npm ci --no-audit --no-fund --loglevel=error)
done
