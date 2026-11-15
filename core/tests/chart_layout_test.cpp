#include <gtest/gtest.h>

#include <cmath>
#include <vector>

#include "hoga/chart_layout.hpp"

using namespace hoga::chart;
using hoga::Candle;

namespace {

std::vector<Candle> series(int n, hoga::Price start = 10'000) {
  std::vector<Candle> bars;
  for (int i = 0; i < n; ++i) {
    const hoga::Price open = start + i * 10;
    const hoga::Price close = open + ((i % 2) ? -20 : 30);
    bars.push_back({i * 60'000LL, open, std::max(open, close) + 10, std::min(open, close) - 10, close, 100 + i});
  }
  return bars;
}

const Viewport kVp{400, 300, 56, 18, 0.22F, 6, 16};

}  // namespace

TEST(ChartLayout, EmptySeriesHasNoShapes) {
  const auto l = layout({}, kVp, {}, true);
  EXPECT_TRUE(l.candles.empty());
  EXPECT_FALSE(l.last.has_value());
}

TEST(ChartLayout, ShowsLatestBarsRightAligned) {
  const auto bars = series(100);
  const auto l = layout(bars, kVp, {60, 0}, false);
  ASSERT_EQ(l.candles.size(), 60u);
  EXPECT_EQ(l.firstIndex, 40);
  // 마지막 봉 중심은 그래프 오른쪽 끝에서 반 칸 안쪽
  const float spacing = (400 - 56) / 60.0F;
  EXPECT_NEAR(l.candles.back().x, 344 - spacing / 2, 0.01);
  EXPECT_TRUE(l.last.has_value());
  EXPECT_EQ(l.last->price, bars.back().close);
}

TEST(ChartLayout, AllShapesStayInsideTheirAreas) {
  const auto bars = series(100);
  const auto l = layout(bars, kVp, {80, 0}, true);
  for (const auto& c : l.candles) {
    EXPECT_GE(c.wickTop, l.priceTop - 0.01F);
    EXPECT_LE(c.wickBottom, l.priceBottom + 0.01F);
    EXPECT_LE(c.wickTop, c.bodyTop + 0.01F);
    EXPECT_GE(c.wickBottom, c.bodyBottom - 0.01F);
    EXPECT_GE(c.volumeTop, l.volumeTop - 0.01F);
    EXPECT_LE(c.volumeBottom, l.volumeBottom + 0.01F);
    EXPECT_GT(c.x, 0);
    EXPECT_LT(c.x, l.plotRight);
  }
  EXPECT_GT(l.priceBottom, l.priceTop);
  EXPECT_LT(l.priceBottom, l.volumeTop);
}

TEST(ChartLayout, UpDownFollowsCloseVsOpen) {
  const auto bars = series(4);
  const auto l = layout(bars, kVp, {20, 0}, false);
  ASSERT_EQ(l.candles.size(), 4u);
  EXPECT_TRUE(l.candles[0].up);
  EXPECT_FALSE(l.candles[1].up);
}

TEST(ChartLayout, ScrollingBackHidesLastPriceLine) {
  const auto bars = series(100);
  const auto l = layout(bars, kVp, {30, 10}, false);
  EXPECT_EQ(l.firstIndex, 60);
  EXPECT_EQ(l.count, 30);
  EXPECT_FALSE(l.last.has_value());
}

TEST(ChartLayout, ClampWindowLimitsZoomAndScroll) {
  EXPECT_EQ(clampWindow({5, 0}, 100).visibleBars, 15);
  EXPECT_EQ(clampWindow({1000, 0}, 100).visibleBars, 300);
  EXPECT_EQ(clampWindow({30, 500}, 100).offset, 70);
  EXPECT_EQ(clampWindow({30, -5}, 100).offset, 0);
  EXPECT_EQ(clampWindow({60, 10}, 20).offset, 0);  // 봉이 화면보다 적으면 스크롤 없음
}

TEST(ChartLayout, MovingAverageOnlyAfterEnoughBars) {
  const auto bars = series(6);
  const auto ma = movingAverage(bars, 5);
  EXPECT_FALSE(ma[3].has_value());
  ASSERT_TRUE(ma[4].has_value());
  double sum = 0;
  for (int i = 0; i < 5; ++i) sum += static_cast<double>(bars[static_cast<std::size_t>(i)].close);
  EXPECT_DOUBLE_EQ(*ma[4], sum / 5);
  const auto l = layout(bars, kVp, {20, 0}, true);
  EXPECT_EQ(l.ma5.size(), 2u);
  EXPECT_TRUE(l.ma20.empty());
}

TEST(ChartLayout, GridLabelsAreOnTickAndInsidePriceArea) {
  const auto bars = series(60, 71'200);  // 호가단위 100원 구간
  const auto l = layout(bars, kVp, {60, 0}, false);
  ASSERT_GE(l.grid.size(), 2u);
  for (const auto& g : l.grid) {
    EXPECT_EQ(g.price % 100, 0) << g.price;
    EXPECT_GE(g.y, l.priceTop - 0.01F);
    EXPECT_LE(g.y, l.priceBottom + 0.01F);
  }
}

TEST(ChartLayout, IndexAtFindsNearestBar) {
  const auto bars = series(100);
  const auto l = layout(bars, kVp, {50, 0}, false);
  EXPECT_EQ(indexAt(l, l.candles[0].x), 50u);
  EXPECT_EQ(indexAt(l, l.candles.back().x + 1), 99u);
  EXPECT_FALSE(indexAt(l, 390).has_value());  // 가격 눈금 영역
}

TEST(ChartLayout, FewBarsFillFromTheRight) {
  const auto bars = series(3);
  const auto l = layout(bars, kVp, {60, 0}, false);
  ASSERT_EQ(l.candles.size(), 3u);
  const float spacing = (400 - 56) / 60.0F;
  EXPECT_NEAR(l.candles[1].x - l.candles[0].x, spacing, 0.01);  // 폭이 갑자기 커지지 않는다
}

TEST(ChartLayout, GridLabelNearLastPriceIsDropped) {
  const auto bars = series(60, 71'200);
  const auto l = layout(bars, kVp, {60, 0}, false);
  ASSERT_TRUE(l.last.has_value());
  for (const auto& g : l.grid) EXPECT_GE(std::abs(g.y - l.last->y), kVp.labelHeight) << g.price;
}
