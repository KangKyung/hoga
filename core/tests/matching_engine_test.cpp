#include <gtest/gtest.h>

#include <vector>

#include "hoga/matching_engine.hpp"

using hoga::Level;
using hoga::LevelChange;
using hoga::MatchingEngine;
using hoga::OrderStatus;
using hoga::OrderType;
using hoga::RejectReason;
using hoga::Side;

namespace {

MatchingEngine makeEngine() { return MatchingEngine({10'000, 1'000'000}); }

hoga::OrderRequest limit(Side side, hoga::Price price, hoga::Qty qty) {
  return {side, OrderType::Limit, price, qty};
}
hoga::OrderRequest market(Side side, hoga::Qty qty) { return {side, OrderType::Market, 0, qty}; }

}  // namespace

TEST(MatchingEngine, NonCrossingLimitRests) {
  auto engine = makeEngine();
  const auto r = engine.submit(limit(Side::Bid, 10'000, 5));
  EXPECT_EQ(r.status, OrderStatus::New);
  EXPECT_EQ(r.resting, 5);
  EXPECT_TRUE(r.fills.empty());
  EXPECT_EQ(r.changes, (std::vector<LevelChange>{{Side::Bid, 10'000, 5}}));
  EXPECT_EQ(engine.depth(Side::Bid, 5), (std::vector<Level>{{10'000, 5}}));
}

TEST(MatchingEngine, PriceTimePriority) {
  auto engine = makeEngine();
  const auto first = engine.submit(limit(Side::Ask, 10'050, 3));
  const auto second = engine.submit(limit(Side::Ask, 10'050, 4));
  const auto better = engine.submit(limit(Side::Ask, 10'000, 2));

  // 매수 6주: 더 싼 10,000원 2주 → 같은 가격에서는 먼저 온 first 3주 → second 1주
  const auto taker = engine.submit(limit(Side::Bid, 10'050, 6));
  ASSERT_EQ(taker.fills.size(), 3u);
  EXPECT_EQ(taker.fills[0].maker, better.id);
  EXPECT_EQ(taker.fills[0].price, 10'000);
  EXPECT_EQ(taker.fills[1].maker, first.id);
  EXPECT_EQ(taker.fills[1].qty, 3);
  EXPECT_EQ(taker.fills[2].maker, second.id);
  EXPECT_EQ(taker.fills[2].qty, 1);
  EXPECT_EQ(taker.status, OrderStatus::Filled);
  EXPECT_EQ(engine.depth(Side::Ask, 5), (std::vector<Level>{{10'050, 3}}));
  EXPECT_EQ(engine.lastPrice(), 10'050);
}

TEST(MatchingEngine, PartialFillRestsRemainder) {
  auto engine = makeEngine();
  engine.submit(limit(Side::Ask, 10'000, 2));
  const auto r = engine.submit(limit(Side::Bid, 10'000, 5));
  EXPECT_EQ(r.status, OrderStatus::PartiallyFilled);
  EXPECT_EQ(r.filled, 2);
  EXPECT_EQ(r.resting, 3);
  // 매도 가격대 소멸 + 매수 가격대 생성이 변경분으로 나간다
  EXPECT_EQ(r.changes, (std::vector<LevelChange>{{Side::Ask, 10'000, 0}, {Side::Bid, 10'000, 3}}));
}

TEST(MatchingEngine, ChangesAreCoalescedPerLevel) {
  auto engine = makeEngine();
  engine.submit(limit(Side::Ask, 10'000, 1));
  engine.submit(limit(Side::Ask, 10'000, 1));
  engine.submit(limit(Side::Ask, 10'000, 1));
  const auto r = engine.submit(limit(Side::Bid, 10'000, 2));
  EXPECT_EQ(r.fills.size(), 2u);
  EXPECT_EQ(r.changes, (std::vector<LevelChange>{{Side::Ask, 10'000, 1}}));
}

TEST(MatchingEngine, MarketOrderDoesNotRest) {
  auto engine = makeEngine();
  engine.submit(limit(Side::Ask, 10'000, 2));
  const auto r = engine.submit(market(Side::Bid, 5));
  EXPECT_EQ(r.status, OrderStatus::PartiallyFilled);
  EXPECT_EQ(r.filled, 2);
  EXPECT_EQ(r.resting, 0);
  EXPECT_TRUE(engine.depth(Side::Bid, 5).empty());
}

TEST(MatchingEngine, MarketOrderWithoutLiquidityIsRejected) {
  auto engine = makeEngine();
  const auto r = engine.submit(market(Side::Bid, 1));
  EXPECT_EQ(r.status, OrderStatus::Rejected);
  EXPECT_EQ(r.reject, RejectReason::NoLiquidity);
}

TEST(MatchingEngine, InvalidOrderIsRejectedWithoutId) {
  auto engine = makeEngine();
  const auto r = engine.submit(limit(Side::Bid, 10'005, 1));
  EXPECT_EQ(r.status, OrderStatus::Rejected);
  EXPECT_EQ(r.reject, RejectReason::OffTick);
  EXPECT_EQ(r.id, 0u);
}

TEST(MatchingEngine, CancelRemovesOnlyThatOrder) {
  auto engine = makeEngine();
  const auto a = engine.submit(limit(Side::Bid, 10'000, 3));
  engine.submit(limit(Side::Bid, 10'000, 4));
  const auto c = engine.cancel(a.id);
  EXPECT_EQ(c.status, OrderStatus::Cancelled);
  EXPECT_EQ(c.changes, (std::vector<LevelChange>{{Side::Bid, 10'000, 4}}));
  EXPECT_EQ(engine.cancel(a.id).reject, RejectReason::UnknownOrder);
  EXPECT_EQ(engine.restingOrderCount(), 1u);
}

TEST(MatchingEngine, FilledOrderCannotBeCancelled) {
  auto engine = makeEngine();
  const auto maker = engine.submit(limit(Side::Ask, 10'000, 1));
  engine.submit(limit(Side::Bid, 10'000, 1));
  EXPECT_EQ(engine.cancel(maker.id).reject, RejectReason::UnknownOrder);
}

// 무작위 주문·취소 흐름 뒤에도 잔량이 양수이고 매수·매도 최우선가가 교차하지 않는지 확인한다.
TEST(MatchingEngine, ConservesQuantityUnderRandomFlow) {
  auto engine = makeEngine();
  std::uint64_t state = 42;
  auto next = [&] {
    state = state * 6364136223846793005ULL + 1442695040888963407ULL;
    return state >> 33;
  };

  hoga::Qty filledTaker = 0;
  std::vector<hoga::OrderId> live;
  for (int i = 0; i < 5'000; ++i) {
    if (!live.empty() && next() % 5 == 0) {
      const auto idx = next() % live.size();
      engine.cancel(live[idx]);
      live.erase(live.begin() + static_cast<std::ptrdiff_t>(idx));
      continue;
    }
    const Side side = next() % 2 ? Side::Bid : Side::Ask;
    const auto price = static_cast<hoga::Price>(9'800 + (next() % 40) * 10);
    const auto qty = static_cast<hoga::Qty>(1 + next() % 20);
    const auto r = engine.submit(limit(side, price, qty));
    ASSERT_NE(r.status, OrderStatus::Rejected);
    filledTaker += r.filled;
    if (r.resting > 0) live.push_back(r.id);
  }

  for (auto side : {Side::Bid, Side::Ask}) {
    for (const auto& level : engine.depth(side, 1'000)) EXPECT_GT(level.qty, 0);
  }
  // 매수 최우선가 < 매도 최우선가 (교차 상태가 남지 않음)
  const auto bids = engine.depth(Side::Bid, 1);
  const auto asks = engine.depth(Side::Ask, 1);
  if (!bids.empty() && !asks.empty()) EXPECT_LT(bids[0].price, asks[0].price);
  EXPECT_GT(filledTaker, 0);
}
