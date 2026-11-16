#include <gtest/gtest.h>

#include <limits>

#include "hoga/order.hpp"

using hoga::OrderType;
using hoga::RejectReason;
using hoga::Side;

TEST(Account, LimitBuyReservesOrderPrice) {
  const hoga::AccountLimits limits{1'000'000, 0};
  EXPECT_EQ(hoga::checkAccount({Side::Bid, OrderType::Limit, 10'000, 100}, limits, 13'000), RejectReason::None);
  EXPECT_EQ(hoga::checkAccount({Side::Bid, OrderType::Limit, 10'000, 101}, limits, 13'000),
            RejectReason::InsufficientCash);
}

TEST(Account, MarketBuyReservesUpperLimit) {
  // 시장가는 체결가를 모르므로 상한가로 잡는다: 1,000,000 / 13,000 = 76주
  const hoga::AccountLimits limits{1'000'000, 0};
  EXPECT_EQ(hoga::reservePrice({Side::Bid, OrderType::Market, 0, 1}, 13'000), 13'000);
  EXPECT_EQ(hoga::checkAccount({Side::Bid, OrderType::Market, 0, 76}, limits, 13'000), RejectReason::None);
  EXPECT_EQ(hoga::checkAccount({Side::Bid, OrderType::Market, 0, 77}, limits, 13'000), RejectReason::InsufficientCash);
  EXPECT_EQ(hoga::maxOrderQty(Side::Bid, OrderType::Market, 0, limits, 13'000, 1'000'000), 76);
}

TEST(Account, SellLimitedBySellableQty) {
  const hoga::AccountLimits limits{0, 30};
  EXPECT_EQ(hoga::checkAccount({Side::Ask, OrderType::Limit, 10'000, 30}, limits, 13'000), RejectReason::None);
  EXPECT_EQ(hoga::checkAccount({Side::Ask, OrderType::Market, 0, 31}, limits, 13'000), RejectReason::InsufficientQty);
  EXPECT_EQ(hoga::maxOrderQty(Side::Ask, OrderType::Limit, 10'000, limits, 13'000, 1'000'000), 30);
}

TEST(Account, MaxQtyRespectsPerOrderCapAndBadPrice) {
  const hoga::AccountLimits rich{std::numeric_limits<hoga::Money>::max(), 0};
  EXPECT_EQ(hoga::maxOrderQty(Side::Bid, OrderType::Limit, 1, rich, 2, 500), 500);
  EXPECT_EQ(hoga::maxOrderQty(Side::Bid, OrderType::Limit, 0, rich, 2, 500), 0);
  // 큰 금액에서도 곱셈이 넘치지 않는다
  EXPECT_EQ(hoga::checkAccount({Side::Bid, OrderType::Limit, 2'000'000, 1'000'000}, rich, 0), RejectReason::None);
  EXPECT_EQ(hoga::checkAccount({Side::Bid, OrderType::Limit, 10'000, 0}, rich, 0), RejectReason::InvalidQty);
}
