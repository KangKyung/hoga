#!/usr/bin/env bash
# C++ 코어: 일반 · ASan · TSan 세 벌을 빌드하고 GoogleTest를 돌린다.
source "$(dirname "$0")/lib.sh"
for san in none address thread; do
  dir="$ROOT/core/build-ci-$san"
  flag=""; [ "$san" != none ] && flag="-DHOGA_SANITIZE=$san"
  echo "== core ($san)"
  cmake -S "$ROOT/core" -B "$dir" -G Ninja -DCMAKE_BUILD_TYPE=Debug $flag > /dev/null
  cmake --build "$dir"
  ctest --test-dir "$dir" --output-on-failure --output-junit "$REPORTS/junit/core-$san.xml"
done

# JSON vs 이진 시세 수신 비용(Release 빌드) — 결과를 보관해 회귀를 본다
cmake -S "$ROOT/core" -B "$ROOT/core/build-ci-release" -G Ninja -DCMAKE_BUILD_TYPE=Release -DHOGA_BUILD_TESTS=ON > /dev/null
cmake --build "$ROOT/core/build-ci-release" --target hoga_wire_bench > /dev/null
mkdir -p "$REPORTS/bench"
"$ROOT/core/build-ci-release/hoga_wire_bench" 200000 | tee "$REPORTS/bench/wire.json"
