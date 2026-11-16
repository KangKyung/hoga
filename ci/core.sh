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
