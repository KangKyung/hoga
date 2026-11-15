#include "NativeHogaCore.h"

#include <algorithm>
#include <cmath>
#include <vector>

#include "PlatformTransport.h"
#include "hoga/core.hpp"

namespace facebook::react {

namespace {

constexpr double kMaxSafeInteger = 9007199254740991.0;  // 2^53 - 1
constexpr std::size_t kMaxDepth = 50;
constexpr std::size_t kMaxSymbols = 50;

hoga::Price requirePrice(jsi::Runtime& rt, double price) {
  // 서버(N-API) 바인딩과 같은 입력 규칙: 가격은 안전한 정수(원)만 허용.
  if (!std::isfinite(price) || std::floor(price) != price || std::fabs(price) > kMaxSafeInteger) {
    throw jsi::JSError(rt, "price must be a safe integer");
  }
  return static_cast<hoga::Price>(price);
}

std::size_t clampCount(double value, std::size_t max) {
  if (!std::isfinite(value) || value < 1) return 1;
  return std::min(static_cast<std::size_t>(value), max);
}

std::vector<std::string> toStrings(jsi::Runtime& rt, const jsi::Array& array) {
  const auto size = array.size(rt);
  if (size > kMaxSymbols) throw jsi::JSError(rt, "too many symbols");
  std::vector<std::string> out;
  out.reserve(size);
  for (std::size_t i = 0; i < size; ++i) {
    const auto value = array.getValueAtIndex(rt, i);
    if (!value.isString()) throw jsi::JSError(rt, "symbols must be strings");
    out.push_back(value.getString(rt).utf8(rt));
  }
  return out;
}

jsi::Array levelsToJs(jsi::Runtime& rt, const std::vector<hoga::Level>& levels) {
  jsi::Array out(rt, levels.size());
  for (std::size_t i = 0; i < levels.size(); ++i) {
    jsi::Array pair(rt, 2);
    pair.setValueAtIndex(rt, 0, static_cast<double>(levels[i].price));
    pair.setValueAtIndex(rt, 1, static_cast<double>(levels[i].qty));
    out.setValueAtIndex(rt, i, std::move(pair));
  }
  return out;
}

jsi::String str(jsi::Runtime& rt, std::string_view s) {
  return jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

}  // namespace

NativeHogaCore::NativeHogaCore(std::shared_ptr<CallInvoker> jsInvoker)
    : NativeHogaCoreCxxSpec(std::move(jsInvoker)) {}

NativeHogaCore::~NativeHogaCore() {
  if (client_) client_->stop();
}

std::string NativeHogaCore::coreVersion(jsi::Runtime& /*rt*/) { return std::string(hoga::coreVersion()); }

double NativeHogaCore::tickSize(jsi::Runtime& rt, double price) {
  return static_cast<double>(hoga::tickSize(requirePrice(rt, price)));
}

double NativeHogaCore::roundToTick(jsi::Runtime& rt, double price, jsi::String mode) {
  const auto m = mode.utf8(rt);
  if (m != "up" && m != "down") throw jsi::JSError(rt, "mode must be 'up' or 'down'");
  return static_cast<double>(
      hoga::roundToTick(requirePrice(rt, price), m == "up" ? hoga::Round::Up : hoga::Round::Down));
}

void NativeHogaCore::connect(jsi::Runtime& rt, jsi::String wsUrl, jsi::String httpBaseUrl) {
  if (client_) client_->stop();

  hoga::MarketClientOptions options;
  options.wsUrl = wsUrl.utf8(rt);
  options.httpBaseUrl = httpBaseUrl.utf8(rt);

  // 상태 변화는 소켓 스레드에서 오므로 JS 스레드로 넘긴 뒤, 모듈이 아직 살아 있을 때만 내보낸다.
  std::weak_ptr<int> alive = alive_;
  auto invoker = jsInvoker_;
  auto listener = [alive, invoker, self = this](hoga::ConnectionState state, std::uint32_t) {
    invoker->invokeAsync([alive, self, state] {
      if (alive.lock()) self->emitOnConnectionState(std::string(hoga::toString(state)));
    });
  };

  client_ = hoga::MarketClient::create(hoga::platform::makePlatformTransport(), std::move(options), listener);
  client_->start();
}

void NativeHogaCore::disconnect(jsi::Runtime& /*rt*/) {
  if (client_) {
    client_->stop();
    client_.reset();
  }
}

void NativeHogaCore::subscribe(jsi::Runtime& rt, jsi::Array symbols) {
  if (!client_) throw jsi::JSError(rt, "call connect() first");
  client_->subscribe(toStrings(rt, symbols));
}

void NativeHogaCore::unsubscribe(jsi::Runtime& rt, jsi::Array symbols) {
  if (client_) client_->unsubscribe(toStrings(rt, symbols));
}

jsi::Object NativeHogaCore::getBook(jsi::Runtime& rt, jsi::String symbol, double depth) {
  jsi::Object out(rt);
  if (!client_) {
    out.setProperty(rt, "subscribed", false);
    return out;
  }
  const auto view = client_->book(symbol.utf8(rt), clampCount(depth, kMaxDepth));
  out.setProperty(rt, "subscribed", view.subscribed);
  out.setProperty(rt, "seq", static_cast<double>(view.seq));
  out.setProperty(rt, "sync", str(rt, hoga::toString(view.sync)));
  out.setProperty(rt, "bids", levelsToJs(rt, view.bids));
  out.setProperty(rt, "asks", levelsToJs(rt, view.asks));
  out.setProperty(rt, "lastUpdateMs", static_cast<double>(view.lastUpdateMs));
  return out;
}

jsi::Array NativeHogaCore::getTrades(jsi::Runtime& rt, jsi::String symbol, double limit) {
  if (!client_) return jsi::Array(rt, 0);
  const auto trades = client_->trades(symbol.utf8(rt), clampCount(limit, 100));
  jsi::Array out(rt, trades.size());
  for (std::size_t i = 0; i < trades.size(); ++i) {
    jsi::Object t(rt);
    t.setProperty(rt, "price", static_cast<double>(trades[i].price));
    t.setProperty(rt, "qty", static_cast<double>(trades[i].qty));
    t.setProperty(rt, "aggressor", str(rt, trades[i].aggressor == hoga::Side::Bid ? "bid" : "ask"));
    t.setProperty(rt, "ts", static_cast<double>(trades[i].ts));
    out.setValueAtIndex(rt, i, std::move(t));
  }
  return out;
}

jsi::Object NativeHogaCore::getStats(jsi::Runtime& rt) {
  jsi::Object out(rt);
  const auto s = client_ ? client_->stats() : hoga::ClientStats{};
  out.setProperty(rt, "state", str(rt, hoga::toString(s.state)));
  out.setProperty(rt, "attempt", static_cast<double>(s.attempt));
  out.setProperty(rt, "messages", static_cast<double>(s.messages));
  out.setProperty(rt, "gaps", static_cast<double>(s.gaps));
  out.setProperty(rt, "resyncs", static_cast<double>(s.resyncs));
  out.setProperty(rt, "reconnects", static_cast<double>(s.reconnects));
  out.setProperty(rt, "parseErrors", static_cast<double>(s.parseErrors));
  out.setProperty(rt, "lastError", str(rt, s.lastError));
  return out;
}

}  // namespace facebook::react
