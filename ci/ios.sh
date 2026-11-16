#!/usr/bin/env bash
# iOS: pod install(Codegen 포함) → 시뮬레이터용 Debug 빌드
source "$(dirname "$0")/lib.sh"
cd "$ROOT/apps/mobile/ios"
RCT_TESTONLY_RNCORE_TARBALL_PATH="$RN_ARTIFACTS/reactnative-core-0.88.1-debug.tar.gz" \
RCT_USE_LOCAL_RN_DEP="$RN_ARTIFACTS/reactnative-dependencies-0.88.1-debug.tar.gz" \
HERMES_ENGINE_TARBALL_PATH="$RN_ARTIFACTS/hermes-ios-260318099.0.5-debug.tar.gz" \
  pod install
xcodebuild -workspace HogaApp.xcworkspace -scheme HogaApp -configuration Debug \
  -destination "generic/platform=iOS Simulator" -derivedDataPath build/dd build -quiet
echo "built: $ROOT/apps/mobile/ios/build/dd/Build/Products/Debug-iphonesimulator/HogaApp.app"
