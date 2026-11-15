#include <gtest/gtest.h>

#include "hoga/core.hpp"

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
