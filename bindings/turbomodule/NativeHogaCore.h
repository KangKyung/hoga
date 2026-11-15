#pragma once

// iOS·Android가 함께 쓰는 C++ TurboModule.
// AppSpecsJSI.h는 apps/mobile/specs/NativeHogaCore.ts로부터 Codegen이 만든다.
#include <AppSpecsJSI.h>

#include <memory>
#include <string>

#include "hoga/market_client.hpp"

namespace facebook::react {

class NativeHogaCore : public NativeHogaCoreCxxSpec<NativeHogaCore> {
 public:
  explicit NativeHogaCore(std::shared_ptr<CallInvoker> jsInvoker);
  ~NativeHogaCore() override;

  std::string coreVersion(jsi::Runtime& rt);
  double tickSize(jsi::Runtime& rt, double price);
  double roundToTick(jsi::Runtime& rt, double price, jsi::String mode);

  void connect(jsi::Runtime& rt, jsi::String wsUrl, jsi::String httpBaseUrl);
  void disconnect(jsi::Runtime& rt);
  void subscribe(jsi::Runtime& rt, jsi::Array symbols);
  void unsubscribe(jsi::Runtime& rt, jsi::Array symbols);

  jsi::Object getBook(jsi::Runtime& rt, jsi::String symbol, double depth);
  jsi::Array getTrades(jsi::Runtime& rt, jsi::String symbol, double limit);
  jsi::Object getStats(jsi::Runtime& rt);

 private:
  std::shared_ptr<hoga::MarketClient> client_;
  // 모듈이 살아 있는 동안만 유효한 표식. 다른 스레드의 콜백은 JS 스레드로 넘어온 뒤 이것을 확인한다.
  std::shared_ptr<int> alive_ = std::make_shared<int>(0);
};

}  // namespace facebook::react
