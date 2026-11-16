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

std::string_view toString(TradingMode mode) noexcept {
  switch (mode) {
    case TradingMode::Continuous: return "CONTINUOUS";
    case TradingMode::Auction: return "AUCTION";
    case TradingMode::Halted: return "HALTED";
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

  if (mode_ == TradingMode::Halted) {
    result.status = OrderStatus::Rejected;
    result.reject = RejectReason::MarketClosed;
    return result;
  }
  if (mode_ == TradingMode::Auction) {
    if (order.type == OrderType::Market) {
      result.status = OrderStatus::Rejected;
      result.reject = RejectReason::MarketInAuction;
      return result;
    }
    // 단일가: 가격이 겹쳐도 체결하지 않고 쌓아 둔다
    result.id = nextId_++;
    if (order.side == Side::Bid) {
      rest(bids_, Side::Bid, order.price, result.id, order.qty, result);
    } else {
      rest(asks_, Side::Ask, order.price, result.id, order.qty, result);
    }
    result.status = OrderStatus::New;
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

ExecutionResult MatchingEngine::reduce(OrderId id, Qty qty) {
  ExecutionResult result;
  result.id = id;
  const auto found = index_.find(id);
  if (found == index_.end()) {
    result.status = OrderStatus::Rejected;
    result.reject = RejectReason::UnknownOrder;
    return result;
  }
  const auto [side, price] = found->second;

  auto shrink = [&](auto& book) {
    auto levelIt = book.find(price);
    auto& level = levelIt->second;
    auto orderIt = std::find_if(level.orders.begin(), level.orders.end(),
                                [&](const Resting& r) { return r.id == id; });
    if (qty <= 0) {
      result.reject = RejectReason::InvalidQty;
    } else if (qty > orderIt->remaining) {
      result.reject = RejectReason::ExceedsOpenQty;
    }
    if (result.reject != RejectReason::None) {
      result.status = OrderStatus::Rejected;
      result.resting = orderIt->remaining;
      return;
    }
    orderIt->remaining -= qty;
    level.total -= qty;
    result.resting = orderIt->remaining;
    recordChange(result, side, price, level.total);
    if (orderIt->remaining == 0) {
      level.orders.erase(orderIt);
      index_.erase(id);
      if (level.orders.empty()) book.erase(levelIt);
      result.status = OrderStatus::Cancelled;
    } else {
      result.status = OrderStatus::New;
    }
  };
  if (side == Side::Bid) {
    shrink(bids_);
  } else {
    shrink(asks_);
  }
  return result;
}

Indicative MatchingEngine::indicative(Price reference) const {
  // 후보 가격: 양쪽에 걸린 모든 가격. 각 가격 p에서 매수 가능량(p 이상 매수) · 매도 가능량(p 이하 매도)
  std::vector<Price> prices;
  prices.reserve(bids_.size() + asks_.size());
  for (const auto& [price, level] : bids_) prices.push_back(price);
  for (const auto& [price, level] : asks_) prices.push_back(price);
  std::sort(prices.begin(), prices.end());
  prices.erase(std::unique(prices.begin(), prices.end()), prices.end());

  Indicative best;
  Qty bestImbalance = 0;
  Price bestDistance = 0;
  for (const Price p : prices) {
    Qty buy = 0;
    for (auto it = bids_.begin(); it != bids_.end() && it->first >= p; ++it) buy += it->second.total;
    Qty sell = 0;
    for (auto it = asks_.begin(); it != asks_.end() && it->first <= p; ++it) sell += it->second.total;
    const Qty executable = std::min(buy, sell);
    if (executable == 0) continue;
    const Qty imbalance = buy > sell ? buy - sell : sell - buy;
    const Price distance = p > reference ? p - reference : reference - p;
    const bool better = executable > best.qty ||
                        (executable == best.qty && (imbalance < bestImbalance ||
                                                    (imbalance == bestImbalance && distance < bestDistance)));
    if (better) {
      best = {p, executable};
      bestImbalance = imbalance;
      bestDistance = distance;
    }
  }
  return best;
}

ExecutionResult MatchingEngine::uncross(Price reference) {
  ExecutionResult result;
  const auto target = indicative(reference);
  result.status = OrderStatus::New;
  if (target.qty == 0) return result;

  Qty left = target.qty;
  while (left > 0) {
    auto bidIt = bids_.begin();
    auto askIt = asks_.begin();
    auto& bid = bidIt->second.orders.front();
    auto& ask = askIt->second.orders.front();
    const Qty traded = std::min({left, bid.remaining, ask.remaining});
    result.fills.push_back({bid.id, ask.id, Side::Bid, target.price, traded});
    left -= traded;
    result.filled += traded;
    bid.remaining -= traded;
    ask.remaining -= traded;
    bidIt->second.total -= traded;
    askIt->second.total -= traded;
    recordChange(result, Side::Bid, bidIt->first, bidIt->second.total);
    recordChange(result, Side::Ask, askIt->first, askIt->second.total);
    if (bid.remaining == 0) {
      index_.erase(bid.id);
      bidIt->second.orders.pop_front();
      if (bidIt->second.orders.empty()) bids_.erase(bidIt);
    }
    if (ask.remaining == 0) {
      index_.erase(ask.id);
      askIt->second.orders.pop_front();
      if (askIt->second.orders.empty()) asks_.erase(askIt);
    }
  }
  lastPrice_ = target.price;
  result.status = OrderStatus::Filled;
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
