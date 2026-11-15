#include <gtest/gtest.h>

#include "hoga/order.hpp"

using hoga::OrderRequest;
using hoga::OrderType;
using hoga::RejectReason;
using hoga::Side;
using hoga::validateOrder;

namespace {
const hoga::ValidationPolicy kPolicy{10'000, 1'000};  // 기준가 1만원 → 7,000 ~ 13,000
}

TEST(ValidateOrder, AcceptsValidLimit) {
  EXPECT_EQ(validateOrder({Side::Bid, OrderType::Limit, 10'050, 10}, kPolicy), RejectReason::None);
}

TEST(ValidateOrder, Quantity) {
  EXPECT_EQ(validateOrder({Side::Bid, OrderType::Limit, 10'000, 0}, kPolicy), RejectReason::InvalidQty);
  EXPECT_EQ(validateOrder({Side::Bid, OrderType::Limit, 10'000, -1}, kPolicy), RejectReason::InvalidQty);
  EXPECT_EQ(validateOrder({Side::Bid, OrderType::Limit, 10'000, 1'001}, kPolicy), RejectReason::QtyTooLarge);
}

TEST(ValidateOrder, PriceTickAndLimit) {
  EXPECT_EQ(validateOrder({Side::Bid, OrderType::Limit, 0, 1}, kPolicy), RejectReason::InvalidPrice);
  EXPECT_EQ(validateOrder({Side::Bid, OrderType::Limit, 10'005, 1}, kPolicy), RejectReason::OffTick);
  EXPECT_EQ(validateOrder({Side::Bid, OrderType::Limit, 13'000, 1}, kPolicy), RejectReason::None);
  EXPECT_EQ(validateOrder({Side::Bid, OrderType::Limit, 13'010, 1}, kPolicy), RejectReason::OutOfPriceLimit);
  EXPECT_EQ(validateOrder({Side::Ask, OrderType::Limit, 6'990, 1}, kPolicy), RejectReason::OutOfPriceLimit);
}

TEST(ValidateOrder, MarketOrderMustHaveNoPrice) {
  EXPECT_EQ(validateOrder({Side::Bid, OrderType::Market, 0, 1}, kPolicy), RejectReason::None);
  EXPECT_EQ(validateOrder({Side::Bid, OrderType::Market, 10'000, 1}, kPolicy), RejectReason::InvalidPrice);
}

TEST(ValidateOrder, ReasonNamesAreStable) {
  EXPECT_EQ(hoga::toString(RejectReason::OffTick), "OFF_TICK");
  EXPECT_EQ(hoga::toString(RejectReason::OutOfPriceLimit), "OUT_OF_PRICE_LIMIT");
}
