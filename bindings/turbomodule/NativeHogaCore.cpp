#include "NativeHogaCore.h"

#include <cmath>

#include "hoga/core.hpp"

namespace facebook::react {

namespace {
constexpr double kMaxSafeInteger = 9007199254740991.0;  // 2^53 - 1
}

NativeHogaCore::NativeHogaCore(std::shared_ptr<CallInvoker> jsInvoker)
    : NativeHogaCoreCxxSpec(std::move(jsInvoker)) {}

std::string NativeHogaCore::coreVersion(jsi::Runtime& /*rt*/) {
  return std::string(hoga::coreVersion());
}

double NativeHogaCore::tickSize(jsi::Runtime& rt, double price) {
  // 서버(N-API) 바인딩과 같은 입력 규칙: 가격은 안전한 정수(원)만 허용.
  if (!std::isfinite(price) || std::floor(price) != price || std::fabs(price) > kMaxSafeInteger) {
    throw jsi::JSError(rt, "price must be a safe integer");
  }
  return static_cast<double>(hoga::tickSize(static_cast<hoga::Price>(price)));
}

}  // namespace facebook::react
