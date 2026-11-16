#include "hoga/order.hpp"

#include <algorithm>

#include "hoga/core.hpp"

namespace hoga {

std::string_view toString(RejectReason reason) noexcept {
  switch (reason) {
    case RejectReason::None: return "NONE";
    case RejectReason::InvalidQty: return "INVALID_QTY";
    case RejectReason::QtyTooLarge: return "QTY_TOO_LARGE";
    case RejectReason::InvalidPrice: return "INVALID_PRICE";
    case RejectReason::OffTick: return "OFF_TICK";
    case RejectReason::OutOfPriceLimit: return "OUT_OF_PRICE_LIMIT";
    case RejectReason::NoLiquidity: return "NO_LIQUIDITY";
    case RejectReason::UnknownOrder: return "UNKNOWN_ORDER";
    case RejectReason::ExceedsOpenQty: return "EXCEEDS_OPEN_QTY";
    case RejectReason::MarketClosed: return "MARKET_CLOSED";
    case RejectReason::MarketInAuction: return "MARKET_IN_AUCTION";
    case RejectReason::InsufficientCash: return "INSUFFICIENT_CASH";
    case RejectReason::InsufficientQty: return "INSUFFICIENT_QTY";
  }
  return "UNKNOWN";
}

RejectReason validateOrder(const OrderRequest& order, const ValidationPolicy& policy) noexcept {
  if (order.qty <= 0) return RejectReason::InvalidQty;
  if (order.qty > policy.maxQty) return RejectReason::QtyTooLarge;

  if (order.type == OrderType::Market) {
    return order.price == 0 ? RejectReason::None : RejectReason::InvalidPrice;
  }

  if (order.price <= 0) return RejectReason::InvalidPrice;
  if (!isOnTick(order.price)) return RejectReason::OffTick;

  if (policy.basePrice > 0) {
    const auto band = priceLimits(policy.basePrice);
    if (order.price < band.lower || order.price > band.upper) return RejectReason::OutOfPriceLimit;
  }
  return RejectReason::None;
}

Price reservePrice(const OrderRequest& order, Price upperLimit) noexcept {
  return order.type == OrderType::Market ? upperLimit : order.price;
}

RejectReason checkAccount(const OrderRequest& order, const AccountLimits& limits, Price upperLimit) noexcept {
  if (order.qty <= 0) return RejectReason::InvalidQty;
  if (order.side == Side::Ask) {
    return order.qty <= limits.sellableQty ? RejectReason::None : RejectReason::InsufficientQty;
  }
  const Price unit = reservePrice(order, upperLimit);
  if (unit <= 0) return RejectReason::InvalidPrice;
  // 곱셈 넘침을 피하려고 나눗셈으로 비교한다(가격·수량 모두 양수)
  if (order.qty > limits.availableCash / unit) return RejectReason::InsufficientCash;
  return RejectReason::None;
}

Qty maxOrderQty(Side side, OrderType type, Price price, const AccountLimits& limits, Price upperLimit,
                Qty maxQty) noexcept {
  Qty qty = 0;
  if (side == Side::Ask) {
    qty = limits.sellableQty;
  } else {
    const Price unit = type == OrderType::Market ? upperLimit : price;
    if (unit <= 0 || limits.availableCash <= 0) return 0;
    qty = limits.availableCash / unit;
  }
  return std::clamp<Qty>(qty, 0, maxQty);
}

}  // namespace hoga
