// Node.js N-API 바인딩: 서버가 앱과 같은 C++ 코어를 쓰게 한다.
#include <napi.h>

#include <cmath>

#include "hoga/core.hpp"

namespace {

constexpr double kMaxSafeInteger = 9007199254740991.0;  // 2^53 - 1

Napi::Value CoreVersion(const Napi::CallbackInfo& info) {
  const auto version = hoga::coreVersion();
  return Napi::String::New(info.Env(), version.data(), version.size());
}

Napi::Value TickSize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "price must be a number").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double price = info[0].As<Napi::Number>().DoubleValue();
  // 가격은 정수(원)만 받는다. JS number가 정확히 표현하는 범위로 제한.
  if (!std::isfinite(price) || std::floor(price) != price || std::fabs(price) > kMaxSafeInteger) {
    Napi::TypeError::New(env, "price must be a safe integer").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const auto tick = hoga::tickSize(static_cast<hoga::Price>(price));
  return Napi::Number::New(env, static_cast<double>(tick));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("coreVersion", Napi::Function::New(env, CoreVersion));
  exports.Set("tickSize", Napi::Function::New(env, TickSize));
  return exports;
}

}  // namespace

NODE_API_MODULE(hoga_node, Init)
