#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <span>
#include <vector>

#include "hoga/types.hpp"

namespace hoga {

// 봉(OHLCV). start는 구간 시작 시각(epoch ms).
struct Candle {
  std::int64_t start{0};
  Price open{0};
  Price high{0};
  Price low{0};
  Price close{0};
  Qty volume{0};
  friend bool operator==(const Candle&, const Candle&) = default;
};

/**
 * 체결 → 봉 집계. 서버(과거 봉 제공)와 앱(실시간 갱신)이 같은 코드를 쓴다.
 *
 * - 기본 구간(예: 1분)으로만 저장하고, 더 긴 구간(5분 등)은 읽을 때 묶어서 만든다.
 * - 체결이 없던 구간은 봉을 만들지 않는다(빈 봉 없음).
 * - 마지막 봉보다 이전 시각의 체결은, 그 구간 봉이 아직 남아 있으면 반영하고 아니면 버린다.
 * - 스레드 안전하지 않다. 호출자가 직렬화한다(MarketClient는 자신의 뮤텍스 안에서 쓴다).
 */
class CandleSeries {
 public:
  explicit CandleSeries(std::int64_t intervalMs = 60'000, std::size_t maxBars = 1'000);

  void addTrade(std::int64_t tsMs, Price price, Qty qty);

  // 과거 봉으로 교체한다. 이미 받은 실시간 봉 중 과거 봉의 마지막보다 새로운 것은 유지한다.
  void mergeHistory(std::span<const Candle> history);

  void clear();

  // 가장 최근 limit개(오래된 것부터). bucketMs는 기본 구간의 배수여야 하며, 아니면 기본 구간을 쓴다.
  std::vector<Candle> bars(std::size_t limit, std::int64_t bucketMs = 0) const;

  std::int64_t intervalMs() const noexcept { return intervalMs_; }
  std::size_t size() const noexcept { return bars_.size(); }
  // 내용이 바뀔 때마다 증가. 화면은 이 값이 바뀌었을 때만 다시 그린다.
  std::uint64_t version() const noexcept { return version_; }

 private:
  std::int64_t bucketStart(std::int64_t ts, std::int64_t bucketMs) const noexcept;
  void trim();

  std::int64_t intervalMs_;
  std::size_t maxBars_;
  std::deque<Candle> bars_;  // start 오름차순
  std::uint64_t version_{0};
};

}  // namespace hoga
