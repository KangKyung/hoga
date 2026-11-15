// Node.js N-API 바인딩: 서버가 앱과 같은 C++ 코어(호가 규칙·주문 검증·매칭 엔진)를 쓰게 한다.
#include <napi.h>

#include <cmath>
#include <optional>
#include <string>

#include "hoga/candles.hpp"
#include "hoga/core.hpp"
#include "hoga/matching_engine.hpp"
#include "hoga/order.hpp"

namespace {

constexpr double kMaxSafeInteger = 9007199254740991.0;  // 2^53 - 1

// ---------- JS ↔ C++ 값 변환 ----------

std::optional<std::int64_t> toSafeInt(const Napi::Value& value) {
  if (!value.IsNumber()) return std::nullopt;
  const double d = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(d) || std::floor(d) != d || std::fabs(d) > kMaxSafeInteger) return std::nullopt;
  return static_cast<std::int64_t>(d);
}

std::int64_t requireSafeInt(const Napi::Env& env, const Napi::Value& value, const char* name) {
  const auto v = toSafeInt(value);
  if (!v) {
    Napi::TypeError::New(env, std::string(name) + " must be a safe integer").ThrowAsJavaScriptException();
    return 0;
  }
  return *v;
}

std::optional<hoga::Side> parseSide(const Napi::Value& value) {
  if (!value.IsString()) return std::nullopt;
  const auto s = value.As<Napi::String>().Utf8Value();
  if (s == "bid") return hoga::Side::Bid;
  if (s == "ask") return hoga::Side::Ask;
  return std::nullopt;
}

const char* sideName(hoga::Side side) { return side == hoga::Side::Bid ? "bid" : "ask"; }

Napi::Number num(const Napi::Env& env, std::int64_t v) { return Napi::Number::New(env, static_cast<double>(v)); }

Napi::Array levelsToJs(const Napi::Env& env, const std::vector<hoga::Level>& levels) {
  auto arr = Napi::Array::New(env, levels.size());
  for (std::size_t i = 0; i < levels.size(); ++i) {
    auto o = Napi::Object::New(env);
    o.Set("price", num(env, levels[i].price));
    o.Set("qty", num(env, levels[i].qty));
    arr.Set(static_cast<uint32_t>(i), o);
  }
  return arr;
}

Napi::Object resultToJs(const Napi::Env& env, const hoga::ExecutionResult& r) {
  auto o = Napi::Object::New(env);
  o.Set("id", num(env, static_cast<std::int64_t>(r.id)));
  o.Set("status", std::string(hoga::toString(r.status)));
  o.Set("reject", std::string(hoga::toString(r.reject)));
  o.Set("filled", num(env, r.filled));
  o.Set("resting", num(env, r.resting));

  auto fills = Napi::Array::New(env, r.fills.size());
  for (std::size_t i = 0; i < r.fills.size(); ++i) {
    const auto& f = r.fills[i];
    auto fo = Napi::Object::New(env);
    fo.Set("taker", num(env, static_cast<std::int64_t>(f.taker)));
    fo.Set("maker", num(env, static_cast<std::int64_t>(f.maker)));
    fo.Set("takerSide", sideName(f.takerSide));
    fo.Set("price", num(env, f.price));
    fo.Set("qty", num(env, f.qty));
    fills.Set(static_cast<uint32_t>(i), fo);
  }
  o.Set("fills", fills);

  auto changes = Napi::Array::New(env, r.changes.size());
  for (std::size_t i = 0; i < r.changes.size(); ++i) {
    const auto& c = r.changes[i];
    auto co = Napi::Object::New(env);
    co.Set("side", sideName(c.side));
    co.Set("price", num(env, c.price));
    co.Set("qty", num(env, c.qty));
    changes.Set(static_cast<uint32_t>(i), co);
  }
  o.Set("changes", changes);
  return o;
}

// { side, type, price, qty } → OrderRequest. 형식이 틀리면 JS TypeError.
std::optional<hoga::OrderRequest> parseOrder(const Napi::Env& env, const Napi::Value& value) {
  if (!value.IsObject()) {
    Napi::TypeError::New(env, "order must be an object").ThrowAsJavaScriptException();
    return std::nullopt;
  }
  const auto obj = value.As<Napi::Object>();
  const auto side = parseSide(obj.Get("side"));
  if (!side) {
    Napi::TypeError::New(env, "order.side must be 'bid' or 'ask'").ThrowAsJavaScriptException();
    return std::nullopt;
  }
  hoga::OrderType type = hoga::OrderType::Limit;
  const auto typeValue = obj.Get("type");
  if (!typeValue.IsUndefined()) {
    const auto t = typeValue.IsString() ? typeValue.As<Napi::String>().Utf8Value() : "";
    if (t == "market") {
      type = hoga::OrderType::Market;
    } else if (t != "limit") {
      Napi::TypeError::New(env, "order.type must be 'limit' or 'market'").ThrowAsJavaScriptException();
      return std::nullopt;
    }
  }
  const auto priceValue = obj.Get("price");
  const auto price = priceValue.IsUndefined() ? 0 : requireSafeInt(env, priceValue, "order.price");
  if (env.IsExceptionPending()) return std::nullopt;
  const auto qty = requireSafeInt(env, obj.Get("qty"), "order.qty");
  if (env.IsExceptionPending()) return std::nullopt;
  return hoga::OrderRequest{*side, type, price, qty};
}

// ---------- 함수 ----------

Napi::Value CoreVersion(const Napi::CallbackInfo& info) {
  const auto version = hoga::coreVersion();
  return Napi::String::New(info.Env(), version.data(), version.size());
}

Napi::Value TickSize(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  const auto price = requireSafeInt(env, info[0], "price");
  if (env.IsExceptionPending()) return env.Undefined();
  return num(env, hoga::tickSize(price));
}

Napi::Value RoundToTick(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  const auto price = requireSafeInt(env, info[0], "price");
  if (env.IsExceptionPending()) return env.Undefined();
  const auto mode = info[1].IsString() ? info[1].As<Napi::String>().Utf8Value() : "";
  if (mode != "up" && mode != "down") {
    Napi::TypeError::New(env, "mode must be 'up' or 'down'").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return num(env, hoga::roundToTick(price, mode == "up" ? hoga::Round::Up : hoga::Round::Down));
}

Napi::Value PriceLimits(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  const auto base = requireSafeInt(env, info[0], "basePrice");
  if (env.IsExceptionPending()) return env.Undefined();
  const auto band = hoga::priceLimits(base);
  auto o = Napi::Object::New(env);
  o.Set("lower", num(env, band.lower));
  o.Set("upper", num(env, band.upper));
  return o;
}

Napi::Value ValidateOrder(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  const auto order = parseOrder(env, info[0]);
  if (!order) return env.Undefined();
  hoga::ValidationPolicy policy;
  if (info[1].IsObject()) {
    const auto p = info[1].As<Napi::Object>();
    if (p.Has("basePrice")) policy.basePrice = requireSafeInt(env, p.Get("basePrice"), "policy.basePrice");
    if (p.Has("maxQty")) policy.maxQty = requireSafeInt(env, p.Get("maxQty"), "policy.maxQty");
    if (env.IsExceptionPending()) return env.Undefined();
  }
  return Napi::String::New(env, std::string(hoga::toString(hoga::validateOrder(*order, policy))));
}

// ---------- MatchingEngine 클래스 ----------

class MatchingEngineWrap : public Napi::ObjectWrap<MatchingEngineWrap> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(env, "MatchingEngine",
                       {
                           InstanceMethod<&MatchingEngineWrap::Submit>("submit"),
                           InstanceMethod<&MatchingEngineWrap::Cancel>("cancel"),
                           InstanceMethod<&MatchingEngineWrap::Depth>("depth"),
                           InstanceAccessor<&MatchingEngineWrap::LastPrice>("lastPrice"),
                           InstanceAccessor<&MatchingEngineWrap::RestingOrderCount>("restingOrderCount"),
                       });
  }

  explicit MatchingEngineWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<MatchingEngineWrap>(info) {
    const auto env = info.Env();
    hoga::ValidationPolicy policy;
    if (!info[0].IsObject()) {
      Napi::TypeError::New(env, "options { basePrice, maxQty? } required").ThrowAsJavaScriptException();
      return;
    }
    const auto opts = info[0].As<Napi::Object>();
    policy.basePrice = requireSafeInt(env, opts.Get("basePrice"), "basePrice");
    if (opts.Has("maxQty")) policy.maxQty = requireSafeInt(env, opts.Get("maxQty"), "maxQty");
    if (env.IsExceptionPending()) return;
    engine_.emplace(policy);
  }

 private:
  Napi::Value Submit(const Napi::CallbackInfo& info) {
    const auto env = info.Env();
    const auto order = parseOrder(env, info[0]);
    if (!order) return env.Undefined();
    return resultToJs(env, engine_->submit(*order));
  }

  Napi::Value Cancel(const Napi::CallbackInfo& info) {
    const auto env = info.Env();
    const auto id = requireSafeInt(env, info[0], "id");
    if (env.IsExceptionPending()) return env.Undefined();
    if (id <= 0) return resultToJs(env, engine_->cancel(0));
    return resultToJs(env, engine_->cancel(static_cast<hoga::OrderId>(id)));
  }

  Napi::Value Depth(const Napi::CallbackInfo& info) {
    const auto env = info.Env();
    const auto side = parseSide(info[0]);
    if (!side) {
      Napi::TypeError::New(env, "side must be 'bid' or 'ask'").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const auto levels = info[1].IsUndefined() ? 10 : requireSafeInt(env, info[1], "levels");
    if (env.IsExceptionPending()) return env.Undefined();
    return levelsToJs(env, engine_->depth(*side, static_cast<std::size_t>(levels < 0 ? 0 : levels)));
  }

  Napi::Value LastPrice(const Napi::CallbackInfo& info) {
    const auto last = engine_->lastPrice();
    return last ? static_cast<Napi::Value>(num(info.Env(), *last)) : info.Env().Null();
  }

  Napi::Value RestingOrderCount(const Napi::CallbackInfo& info) {
    return num(info.Env(), static_cast<std::int64_t>(engine_->restingOrderCount()));
  }

  std::optional<hoga::MatchingEngine> engine_;
};

// ---------- CandleSeries 클래스 ----------

class CandleSeriesWrap : public Napi::ObjectWrap<CandleSeriesWrap> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(env, "CandleSeries",
                       {
                           InstanceMethod<&CandleSeriesWrap::AddTrade>("addTrade"),
                           InstanceMethod<&CandleSeriesWrap::Bars>("bars"),
                           InstanceAccessor<&CandleSeriesWrap::Version>("version"),
                       });
  }

  explicit CandleSeriesWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<CandleSeriesWrap>(info) {
    const auto env = info.Env();
    std::int64_t interval = 60'000;
    std::int64_t maxBars = 1'000;
    if (info[0].IsObject()) {
      const auto opts = info[0].As<Napi::Object>();
      if (opts.Has("intervalMs")) interval = requireSafeInt(env, opts.Get("intervalMs"), "intervalMs");
      if (opts.Has("maxBars")) maxBars = requireSafeInt(env, opts.Get("maxBars"), "maxBars");
      if (env.IsExceptionPending()) return;
    }
    series_.emplace(interval, static_cast<std::size_t>(maxBars < 1 ? 1 : maxBars));
  }

 private:
  Napi::Value AddTrade(const Napi::CallbackInfo& info) {
    const auto env = info.Env();
    const auto ts = requireSafeInt(env, info[0], "ts");
    const auto price = requireSafeInt(env, info[1], "price");
    const auto qty = requireSafeInt(env, info[2], "qty");
    if (env.IsExceptionPending()) return env.Undefined();
    series_->addTrade(ts, price, qty);
    return env.Undefined();
  }

  // [[start, open, high, low, close, volume], ...] 오래된 것부터
  Napi::Value Bars(const Napi::CallbackInfo& info) {
    const auto env = info.Env();
    const auto limit = info[0].IsUndefined() ? 200 : requireSafeInt(env, info[0], "limit");
    const auto bucket = info[1].IsUndefined() ? 0 : requireSafeInt(env, info[1], "bucketMs");
    if (env.IsExceptionPending()) return env.Undefined();
    const auto bars = series_->bars(static_cast<std::size_t>(limit < 0 ? 0 : limit), bucket);
    auto arr = Napi::Array::New(env, bars.size());
    for (std::size_t i = 0; i < bars.size(); ++i) {
      auto row = Napi::Array::New(env, 6);
      const auto& c = bars[i];
      row.Set(0u, num(env, c.start));
      row.Set(1u, num(env, c.open));
      row.Set(2u, num(env, c.high));
      row.Set(3u, num(env, c.low));
      row.Set(4u, num(env, c.close));
      row.Set(5u, num(env, c.volume));
      arr.Set(static_cast<uint32_t>(i), row);
    }
    return arr;
  }

  Napi::Value Version(const Napi::CallbackInfo& info) {
    return num(info.Env(), static_cast<std::int64_t>(series_->version()));
  }

  std::optional<hoga::CandleSeries> series_;
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("coreVersion", Napi::Function::New(env, CoreVersion));
  exports.Set("tickSize", Napi::Function::New(env, TickSize));
  exports.Set("roundToTick", Napi::Function::New(env, RoundToTick));
  exports.Set("priceLimits", Napi::Function::New(env, PriceLimits));
  exports.Set("validateOrder", Napi::Function::New(env, ValidateOrder));
  exports.Set("MatchingEngine", MatchingEngineWrap::Define(env));
  exports.Set("CandleSeries", CandleSeriesWrap::Define(env));
  return exports;
}

}  // namespace

NODE_API_MODULE(hoga_node, Init)
