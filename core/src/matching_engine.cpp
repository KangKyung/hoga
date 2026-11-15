#include "hoga/matching_engine.hpp"

#include <algorithm>

namespace hoga {

std::string_view toString(OrderStatus status) noexcept {
  switch (status) {
    case OrderStatus::New: return "NEW";
    case OrderStatus::PartiallyFilled: return "PARTIALLY_FILLED";
    case OrderStatus::Filled: return "FILLED";
    case OrderStatus::Cancelled: return "CANCELLED";
    case OrderStatus::Rejected: return "REJECTED";
  }
  return "UNKNOWN";
}

MatchingEngine::MatchingEngine(ValidationPolicy policy) : policy_(policy) {}

void MatchingEngine::recordChange(ExecutionResult& result, Side side, Price price, Qty qty) {
  // 같은 가격대가 여러 번 바뀌면 마지막 값 하나로 합친다.
  for (auto& change : result.changes) {
    if (change.side == side && change.price == price) {
      change.qty = qty;
      return;
    }
  }
  result.changes.push_back({side, price, qty});
}

template <typename BookMap>
void MatchingEngine::matchAgainst(BookMap& book, Side makerSide, const OrderRequest& order,
                                  OrderId takerId, ExecutionResult& result) {
  Qty remaining = order.qty;
  const bool isMarket = order.type == OrderType::Market;

  auto crosses = [&](Price makerPrice) {
    if (isMarket) return true;
    return order.side == Side::Bid ? makerPrice <= order.price : makerPrice >= order.price;
  };

  while (remaining > 0 && !book.empty()) {
    auto levelIt = book.begin();
    const Price levelPrice = levelIt->first;
    if (!crosses(levelPrice)) break;

    auto& level = levelIt->second;
    while (remaining > 0 && !level.orders.empty()) {
      auto& maker = level.orders.front();
      const Qty traded = std::min(remaining, maker.remaining);

      result.fills.push_back({takerId, maker.id, order.side, levelPrice, traded});
      remaining -= traded;
      maker.remaining -= traded;
      level.total -= traded;
      lastPrice_ = levelPrice;

      if (maker.remaining == 0) {
        index_.erase(maker.id);
        level.orders.pop_front();
      }
    }

    recordChange(result, makerSide, levelPrice, level.total);
    if (level.orders.empty()) book.erase(levelIt);
  }

  result.filled = order.qty - remaining;
}

template <typename BookMap>
void MatchingEngine::rest(BookMap& book, Side side, Price price, OrderId id, Qty qty,
                          ExecutionResult& result) {
  auto& level = book[price];
  level.orders.push_back({id, qty});
  level.total += qty;
  index_[id] = {side, price};
  result.resting = qty;
  recordChange(result, side, price, level.total);
}

ExecutionResult MatchingEngine::submit(const OrderRequest& order) {
  ExecutionResult result;

  result.reject = validateOrder(order, policy_);
  if (result.reject != RejectReason::None) {
    result.status = OrderStatus::Rejected;
    return result;
  }

  if (order.type == OrderType::Market) {
    const bool noLiquidity = order.side == Side::Bid ? asks_.empty() : bids_.empty();
    if (noLiquidity) {
      result.status = OrderStatus::Rejected;
      result.reject = RejectReason::NoLiquidity;
      return result;
    }
  }

  result.id = nextId_++;

  if (order.side == Side::Bid) {
    matchAgainst(asks_, Side::Ask, order, result.id, result);
  } else {
    matchAgainst(bids_, Side::Bid, order, result.id, result);
  }

  const Qty remaining = order.qty - result.filled;
  if (remaining > 0 && order.type == OrderType::Limit) {
    if (order.side == Side::Bid) {
      rest(bids_, Side::Bid, order.price, result.id, remaining, result);
    } else {
      rest(asks_, Side::Ask, order.price, result.id, remaining, result);
    }
  }

  if (result.filled == order.qty) {
    result.status = OrderStatus::Filled;
  } else if (result.filled > 0) {
    // 시장가 잔량은 버려지지만 일부라도 체결됐으면 부분 체결로 본다.
    result.status = OrderStatus::PartiallyFilled;
  } else {
    result.status = order.type == OrderType::Market ? OrderStatus::Cancelled : OrderStatus::New;
  }
  return result;
}

ExecutionResult MatchingEngine::cancel(OrderId id) {
  ExecutionResult result;
  result.id = id;

  const auto found = index_.find(id);
  if (found == index_.end()) {
    result.status = OrderStatus::Rejected;
    result.reject = RejectReason::UnknownOrder;
    return result;
  }
  const auto [side, price] = found->second;
  index_.erase(found);

  auto removeFrom = [&](auto& book) {
    auto levelIt = book.find(price);
    if (levelIt == book.end()) return;
    auto& level = levelIt->second;
    auto orderIt = std::find_if(level.orders.begin(), level.orders.end(),
                                [&](const Resting& r) { return r.id == id; });
    if (orderIt == level.orders.end()) return;
    level.total -= orderIt->remaining;
    level.orders.erase(orderIt);
    recordChange(result, side, price, level.total);
    if (level.orders.empty()) book.erase(levelIt);
  };

  if (side == Side::Bid) {
    removeFrom(bids_);
  } else {
    removeFrom(asks_);
  }
  result.status = OrderStatus::Cancelled;
  return result;
}

std::vector<Level> MatchingEngine::depth(Side side, std::size_t levels) const {
  std::vector<Level> out;
  auto collect = [&](const auto& book) {
    for (auto it = book.begin(); it != book.end() && out.size() < levels; ++it) {
      out.push_back({it->first, it->second.total});
    }
  };
  if (side == Side::Bid) {
    collect(bids_);
  } else {
    collect(asks_);
  }
  return out;
}

}  // namespace hoga
