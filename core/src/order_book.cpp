#include "hoga/order_book.hpp"

#include <algorithm>
#include <mutex>

namespace hoga {

namespace {

template <typename Map>
void fill(Map& map, std::span<const Level> levels) {
  map.clear();
  for (const auto& level : levels) {
    if (level.price > 0 && level.qty > 0) map[level.price] = level.qty;
  }
}

template <typename Map>
std::vector<Level> takeTop(const Map& map, std::size_t depth) {
  std::vector<Level> out;
  out.reserve(std::min(depth, map.size()));
  for (auto it = map.begin(); it != map.end() && out.size() < depth; ++it) {
    out.push_back({it->first, it->second});
  }
  return out;
}

template <typename Map>
void setLevel(Map& map, Price price, Qty qty) {
  if (qty == 0) {
    map.erase(price);
  } else {
    map[price] = qty;
  }
}

}  // namespace

void OrderBook::applySnapshot(Seq seq, std::span<const Level> bids, std::span<const Level> asks) {
  std::unique_lock lock(mutex_);
  fill(bids_, bids);
  fill(asks_, asks);
  seq_ = seq;
  hasSnapshot_ = true;
}

ApplyResult OrderBook::applyDelta(Seq seq, Side side, Price price, Qty qty) {
  if (price <= 0 || qty < 0) return ApplyResult::Invalid;

  std::unique_lock lock(mutex_);
  if (!hasSnapshot_) return ApplyResult::Gap;
  if (seq <= seq_) return ApplyResult::Stale;
  if (seq != seq_ + 1) return ApplyResult::Gap;

  if (side == Side::Bid) {
    setLevel(bids_, price, qty);
  } else {
    setLevel(asks_, price, qty);
  }
  seq_ = seq;
  return ApplyResult::Applied;
}

void OrderBook::clear() {
  std::unique_lock lock(mutex_);
  bids_.clear();
  asks_.clear();
  seq_ = 0;
  hasSnapshot_ = false;
}

std::vector<Level> OrderBook::top(Side side, std::size_t depth) const {
  std::shared_lock lock(mutex_);
  return side == Side::Bid ? takeTop(bids_, depth) : takeTop(asks_, depth);
}

std::optional<Price> OrderBook::bestBid() const {
  std::shared_lock lock(mutex_);
  if (bids_.empty()) return std::nullopt;
  return bids_.begin()->first;
}

std::optional<Price> OrderBook::bestAsk() const {
  std::shared_lock lock(mutex_);
  if (asks_.empty()) return std::nullopt;
  return asks_.begin()->first;
}

Seq OrderBook::seq() const {
  std::shared_lock lock(mutex_);
  return seq_;
}

bool OrderBook::hasSnapshot() const {
  std::shared_lock lock(mutex_);
  return hasSnapshot_;
}

}  // namespace hoga
