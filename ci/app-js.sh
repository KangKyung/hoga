#!/usr/bin/env bash
# 앱 JS: Jest · tsc · ESLint
source "$(dirname "$0")/lib.sh"
cd "$ROOT/apps/mobile"
npx tsc --noEmit
npx eslint .
JEST_JUNIT_OUTPUT_DIR="$REPORTS/junit" JEST_JUNIT_OUTPUT_NAME=app-jest.xml \
  npx jest --ci --maxWorkers=2 --reporters=default --reporters=jest-junit
