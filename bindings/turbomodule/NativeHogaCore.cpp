#include "NativeHogaCore.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <random>
#include <vector>

#include "ChartDataSource.h"
#include "PlatformTransport.h"
#include "hoga/core.hpp"
#include "hoga/order.hpp"

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

jsi::Object NativeHogaCore::priceLimits(jsi::Runtime& rt, double basePrice) {
  const auto band = hoga::priceLimits(requirePrice(rt, basePrice));
  jsi::Object out(rt);
  out.setProperty(rt, "lower", static_cast<double>(band.lower));
  out.setProperty(rt, "upper", static_cast<double>(band.upper));
  return out;
}

std::string NativeHogaCore::validateOrder(jsi::Runtime& rt, jsi::String side, jsi::String type, double price,
                                          double qty, double basePrice) {
  const auto s = side.utf8(rt);
  const auto t = type.utf8(rt);
  if (s != "bid" && s != "ask") throw jsi::JSError(rt, "side must be 'bid' or 'ask'");
  if (t != "limit" && t != "market") throw jsi::JSError(rt, "type must be 'limit' or 'market'");
  // 수량이 소수면 서버도 형식 오류로 거부하므로 여기서는 업무 규칙상 INVALID_QTY로 본다.
  if (!std::isfinite(qty) || std::floor(qty) != qty) return std::string(hoga::toString(hoga::RejectReason::InvalidQty));
  const hoga::OrderRequest order{s == "bid" ? hoga::Side::Bid : hoga::Side::Ask,
                                 t == "limit" ? hoga::OrderType::Limit : hoga::OrderType::Market,
                                 requirePrice(rt, price), static_cast<hoga::Qty>(qty)};
  hoga::ValidationPolicy policy;
  policy.basePrice = requirePrice(rt, basePrice);
  return std::string(hoga::toString(hoga::validateOrder(order, policy)));
}

std::string NativeHogaCore::randomId(jsi::Runtime& /*rt*/) {
  // UUID v4. std::random_device는 iOS·Android에서 OS 난수원(arc4random / urandom)을 쓴다.
  std::random_device rd;
  std::uniform_int_distribution<unsigned> byte(0, 255);
  unsigned char b[16];
  for (auto& x : b) x = static_cast<unsigned char>(byte(rd));
  b[6] = static_cast<unsigned char>((b[6] & 0x0F) | 0x40);
  b[8] = static_cast<unsigned char>((b[8] & 0x3F) | 0x80);
  char out[37];
  std::snprintf(out, sizeof(out), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", b[0], b[1],
                b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
  return out;
}

void NativeHogaCore::setAuthToken(jsi::Runtime& rt, jsi::String token) {
  authToken_ = token.utf8(rt);
  if (client_) client_->setAuthToken(authToken_);
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
  client_->setUserEventListener([alive, invoker, self = this](const std::string& json) {
    invoker->invokeAsync([alive, self, json] {
      if (alive.lock()) self->emitOnOrderEvent(json);
    });
  });
  if (!authToken_.empty()) client_->setAuthToken(authToken_);
  hoga::chartsource::setClient(client_);  // 네이티브 차트가 직접 읽는다
  client_->start();
}

void NativeHogaCore::disconnect(jsi::Runtime& /*rt*/) {
  if (client_) {
    client_->stop();
    client_.reset();
    hoga::chartsource::setClient(nullptr);
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
