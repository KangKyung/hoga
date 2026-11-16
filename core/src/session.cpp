#include "hoga/session.hpp"

namespace hoga {

std::string_view toString(MarketPhase phase) noexcept {
  switch (phase) {
    case MarketPhase::PreOpen: return "PRE_OPEN";
    case MarketPhase::Open: return "OPEN";
    case MarketPhase::Closing: return "CLOSING";
    case MarketPhase::Closed: return "CLOSED";
  }
  return "UNKNOWN";
}

std::string_view toString(ViKind kind) noexcept {
  switch (kind) {
    case ViKind::None: return "NONE";
    case ViKind::Static: return "STATIC";
    case ViKind::Dynamic: return "DYNAMIC";
  }
  return "UNKNOWN";
}

MarketPhase phaseAt(int minute) noexcept {
  constexpr int kPreOpen = 8 * 60 + 30;
  constexpr int kOpen = 9 * 60;
  constexpr int kClosing = 15 * 60 + 20;
  constexpr int kClosed = 15 * 60 + 30;
  if (minute >= kPreOpen && minute < kOpen) return MarketPhase::PreOpen;
  if (minute >= kOpen && minute < kClosing) return MarketPhase::Open;
  if (minute >= kClosing && minute < kClosed) return MarketPhase::Closing;
  return MarketPhase::Closed;
}

namespace {
// |price - ref| / ref >= bps / 10000 (정수 연산)
bool moved(Price ref, Price price, int bps) noexcept {
  if (ref <= 0 || bps <= 0) return false;
  const Price diff = price > ref ? price - ref : ref - price;
  return diff * 10'000 >= ref * static_cast<Price>(bps);
}
}  // namespace

ViKind checkVi(Price staticRef, Price dynamicRef, Price price, const ViPolicy& policy) noexcept {
  if (price <= 0) return ViKind::None;
  if (moved(staticRef, price, policy.staticBps)) return ViKind::Static;
  if (moved(dynamicRef, price, policy.dynamicBps)) return ViKind::Dynamic;
  return ViKind::None;
}

}  // namespace hoga
