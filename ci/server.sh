#!/usr/bin/env bash
# Node 애드온(N-API, 같은 C++ 코어) → 애드온 테스트 → 서버 vitest · 타입 검사
# (클러스터 시험은 redis-server가 있으면 market 1 + gateway 2를 실제 Redis로 띄운다)
source "$(dirname "$0")/lib.sh"
cd "$ROOT/bindings/node"
npx cmake-js compile -G Ninja > /dev/null
node --test --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=junit --test-reporter-destination="$REPORTS/junit/node-binding.xml" "test/**/*.test.js"
cd "$ROOT/server"
npx tsc --noEmit
npx vitest run --reporter=default --reporter=junit --outputFile.junit="$REPORTS/junit/server.xml"
