#include <gtest/gtest.h>

#include "hoga/core.hpp"

using hoga::PriceBand;
using hoga::Round;
using hoga::roundToTick;
using hoga::tickSize;

TEST(CoreVersion, IsNotEmpty) { EXPECT_FALSE(hoga::coreVersion().empty()); }

TEST(TickSize, InvalidPriceReturnsZero) {
  EXPECT_EQ(tickSize(0), 0);
  EXPECT_EQ(tickSize(-100), 0);
}

// 각 가격대 경계 바로 아래와 경계값을 함께 확인한다.
TEST(TickSize, BandBoundaries) {
  EXPECT_EQ(tickSize(1), 1);
  EXPECT_EQ(tickSize(1'999), 1);
  EXPECT_EQ(tickSize(2'000), 5);
  EXPECT_EQ(tickSize(4'999), 5);
  EXPECT_EQ(tickSize(5'000), 10);
  EXPECT_EQ(tickSize(19'999), 10);
  EXPECT_EQ(tickSize(20'000), 50);
  EXPECT_EQ(tickSize(49'999), 50);
  EXPECT_EQ(tickSize(50'000), 100);
  EXPECT_EQ(tickSize(199'999), 100);
  EXPECT_EQ(tickSize(200'000), 500);
  EXPECT_EQ(tickSize(499'999), 500);
  EXPECT_EQ(tickSize(500'000), 1'000);
  EXPECT_EQ(tickSize(3'000'000), 1'000);
}

TEST(IsOnTick, MatchesBand) {
  EXPECT_TRUE(hoga::isOnTick(1'999));
  EXPECT_FALSE(hoga::isOnTick(2'001));
  EXPECT_TRUE(hoga::isOnTick(2'005));
  EXPECT_FALSE(hoga::isOnTick(71'250));
  EXPECT_TRUE(hoga::isOnTick(71'200));
  EXPECT_FALSE(hoga::isOnTick(0));
}

TEST(RoundToTick, DownAndUp) {
  EXPECT_EQ(roundToTick(71'250, Round::Down), 71'200);
  EXPECT_EQ(roundToTick(71'250, Round::Up), 71'300);
  EXPECT_EQ(roundToTick(71'200, Round::Up), 71'200);  // 이미 단위에 맞으면 그대로
  EXPECT_EQ(roundToTick(0, Round::Up), 0);
}

// 올림이 다음 가격대 경계로 넘어가도 결과가 그 가격대 단위에 맞아야 한다.
TEST(RoundToTick, UpCrossesBandBoundary) {
  EXPECT_EQ(roundToTick(4'998, Round::Up), 5'000);
  EXPECT_EQ(roundToTick(49'990, Round::Up), 50'000);
  EXPECT_EQ(roundToTick(499'900, Round::Up), 500'000);
  for (hoga::Price p = 1; p < 600'000; p += 7) {
    EXPECT_TRUE(hoga::isOnTick(roundToTick(p, Round::Up))) << p;
    EXPECT_TRUE(hoga::isOnTick(roundToTick(p, Round::Down))) << p;
  }
}

TEST(PriceLimits, ThirtyPercentOnTick) {
  // 기준가 10,000원: 폭 3,000 → 13,000 / 7,000
  EXPECT_EQ(hoga::priceLimits(10'000), (PriceBand{7'000, 13'000}));
  // 기준가 71,200원(호가단위 100): 폭 21,360 → 21,300 → 92,500 / 49,900 → 단위 올림 49,900
  const auto band = hoga::priceLimits(71'200);
  EXPECT_EQ(band.upper, 92'500);
  EXPECT_EQ(band.lower, 49'900);
  EXPECT_TRUE(hoga::isOnTick(band.upper));
  EXPECT_TRUE(hoga::isOnTick(band.lower));
  EXPECT_EQ(hoga::priceLimits(0), (PriceBand{}));
}
