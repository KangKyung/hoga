#include <gtest/gtest.h>

#include <vector>

#include "hoga/candles.hpp"

using hoga::Candle;
using hoga::CandleSeries;

constexpr std::int64_t kMin = 60'000;

TEST(CandleSeries, BuildsOhlcvPerMinute) {
  CandleSeries s(kMin);
  s.addTrade(0 * kMin + 1'000, 100, 1);
  s.addTrade(0 * kMin + 2'000, 105, 2);
  s.addTrade(0 * kMin + 3'000, 98, 3);
  s.addTrade(0 * kMin + 59'999, 101, 4);
  s.addTrade(1 * kMin, 102, 5);  // 경계 → 다음 봉
  const auto bars = s.bars(10);
  ASSERT_EQ(bars.size(), 2u);
  EXPECT_EQ(bars[0], (Candle{0, 100, 105, 98, 101, 10}));
  EXPECT_EQ(bars[1], (Candle{kMin, 102, 102, 102, 102, 5}));
}

TEST(CandleSeries, NoEmptyBarsForQuietMinutes) {
  CandleSeries s(kMin);
  s.addTrade(0, 100, 1);
  s.addTrade(5 * kMin, 110, 1);
  EXPECT_EQ(s.size(), 2u);
}

TEST(CandleSeries, LateTradeUpdatesItsOwnBar) {
  CandleSeries s(kMin);
  s.addTrade(0, 100, 1);
  s.addTrade(kMin, 110, 1);
  s.addTrade(30'000, 120, 2);  // 첫 봉에 늦게 도착
  const auto bars = s.bars(10);
  EXPECT_EQ(bars[0].high, 120);
  EXPECT_EQ(bars[0].close, 100);  // 마지막 봉이 아니면 종가는 바꾸지 않는다
  EXPECT_EQ(bars[0].volume, 3);
  EXPECT_EQ(bars[1].close, 110);
}

TEST(CandleSeries, AggregatesLongerIntervalOnRead) {
  CandleSeries s(kMin);
  for (int m = 0; m < 10; ++m) s.addTrade(m * kMin, 100 + m, 1);
  const auto five = s.bars(10, 5 * kMin);
  ASSERT_EQ(five.size(), 2u);
  EXPECT_EQ(five[0], (Candle{0, 100, 104, 100, 104, 5}));
  EXPECT_EQ(five[1], (Candle{5 * kMin, 105, 109, 105, 109, 5}));
  EXPECT_EQ(s.bars(1, 5 * kMin).size(), 1u);
  EXPECT_EQ(s.bars(1, 5 * kMin)[0].start, 5 * kMin);
}

TEST(CandleSeries, MergeHistoryKeepsNewerLiveBars) {
  CandleSeries s(kMin);
  s.addTrade(9 * kMin, 200, 1);   // 실시간으로 이미 받은 봉
  s.addTrade(10 * kMin, 210, 1);
  const std::vector<Candle> history{{8 * kMin, 1, 2, 1, 2, 1}, {9 * kMin, 3, 4, 3, 4, 1}};
  const auto before = s.version();
  s.mergeHistory(history);
  const auto bars = s.bars(10);
  ASSERT_EQ(bars.size(), 3u);
  EXPECT_EQ(bars[0].start, 8 * kMin);
  EXPECT_EQ(bars[1].close, 4);  // 겹치는 구간은 과거 봉(서버 기준)으로
  EXPECT_EQ(bars[2].close, 210);
  EXPECT_GT(s.version(), before);
}

TEST(CandleSeries, KeepsAtMostMaxBars) {
  CandleSeries s(kMin, 3);
  for (int m = 0; m < 5; ++m) s.addTrade(m * kMin, 100, 1);
  const auto bars = s.bars(10);
  ASSERT_EQ(bars.size(), 3u);
  EXPECT_EQ(bars.front().start, 2 * kMin);
  s.addTrade(0, 100, 1);  // 보관 범위보다 오래된 체결은 버린다
  EXPECT_EQ(s.bars(10).front().start, 2 * kMin);
}

TEST(CandleSeries, IgnoresInvalidTrades) {
  CandleSeries s(kMin);
  s.addTrade(0, 0, 1);
  s.addTrade(0, 100, 0);
  EXPECT_EQ(s.size(), 0u);
}
