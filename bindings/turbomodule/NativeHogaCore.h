#pragma once

// iOS·Android가 함께 쓰는 C++ TurboModule.
// AppSpecsJSI.h는 apps/mobile/specs/NativeHogaCore.ts로부터 Codegen이 만든다.
#include <AppSpecsJSI.h>

#include <memory>
#include <string>

namespace facebook::react {

class NativeHogaCore : public NativeHogaCoreCxxSpec<NativeHogaCore> {
 public:
  explicit NativeHogaCore(std::shared_ptr<CallInvoker> jsInvoker);

  std::string coreVersion(jsi::Runtime& rt);
  double tickSize(jsi::Runtime& rt, double price);
};

}  // namespace facebook::react
