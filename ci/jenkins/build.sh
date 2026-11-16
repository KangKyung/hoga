#!/usr/bin/env bash
# 잡 실행: ci/jenkins/build.sh [E2E=true] [BENCH=false] [LOAD=false]
set -euo pipefail
CI_HOME="${HOGA_CI_HOME:-$HOME/.hoga-ci}"
URL="http://127.0.0.1:${JENKINS_PORT:-8088}"
AUTH="admin:$(cat "$CI_HOME/jenkins/hoga-admin-password")"
jar="$(mktemp)"; trap 'rm -f "$jar"' EXIT
crumb=$(curl -sf -u "$AUTH" -c "$jar" "$URL/crumbIssuer/api/json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["crumbRequestField"]+":"+d["crumb"])')
query=$(IFS='&'; echo "$*")
# 첫 실행 전에는 잡에 매개변수가 없다(Jenkinsfile을 한 번 읽어야 생김) → 그땐 기본값으로 실행
if curl -sf -u "$AUTH" "$URL/job/hoga/api/json?tree=property%5BparameterDefinitions%5Bname%5D%5D" | grep -q parameterDefinitions; then
  curl -sf -u "$AUTH" -b "$jar" -H "$crumb" -X POST "$URL/job/hoga/buildWithParameters?$query"
else
  curl -sf -u "$AUTH" -b "$jar" -H "$crumb" -X POST "$URL/job/hoga/build"
fi
echo "queued: $URL/job/hoga/"
