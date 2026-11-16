#!/usr/bin/env bash
# 지금 작업 트리(커밋 안 한 변경·새 파일 포함, .gitignore 제외)를 커밋 객체 하나로 만들어
# 로컬 CI 저장소의 ci 브랜치로 올린다. 현재 브랜치·인덱스·작업 트리는 건드리지 않는다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="${HOGA_CI_HOME:-$HOME/.hoga-ci}/repo.git"
cd "$ROOT"
[ -d "$REPO" ] || git init -q --bare "$REPO"
index="$(mktemp)"; trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git read-tree HEAD
GIT_INDEX_FILE="$index" git add -A
tree=$(GIT_INDEX_FILE="$index" git write-tree)
commit=$(git commit-tree "$tree" -p HEAD -m "CI snapshot of $(git rev-parse --abbrev-ref HEAD) working tree")
git push -q -f "$REPO" "$commit:refs/heads/ci"
echo "ci ← $commit ($(git rev-parse --abbrev-ref HEAD) + 작업 트리)"
