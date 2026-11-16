#!/usr/bin/env bash
# 자체 도구: hoga-cli 테스트 · 타입 검사 + 앱 버전이 모든 파일에서 같은지
source "$(dirname "$0")/lib.sh"
cd "$ROOT/tools/hoga-cli"
npx tsc --noEmit
node --import tsx --test --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=junit --test-reporter-destination="$REPORTS/junit/hoga-cli.xml" test/*.test.ts
node --import tsx src/main.ts status
