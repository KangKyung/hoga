#include "hoga/order.hpp"

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

}  // namespace hoga
