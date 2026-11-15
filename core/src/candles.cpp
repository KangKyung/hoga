#include "hoga/candles.hpp"

#include <algorithm>
#include <limits>

namespace hoga {

CandleSeries::CandleSeries(std::int64_t intervalMs, std::size_t maxBars)
    : intervalMs_(intervalMs > 0 ? intervalMs : 60'000), maxBars_(maxBars > 0 ? maxBars : 1) {}

std::int64_t CandleSeries::bucketStart(std::int64_t ts, std::int64_t bucketMs) const noexcept {
  // 음수 시각도 아래로 내림이 되도록(C++ 나눗셈은 0 쪽으로 자르므로 보정)
  std::int64_t q = ts / bucketMs;
  if (ts % bucketMs != 0 && ts < 0) --q;
  return q * bucketMs;
}

void CandleSeries::trim() {
  while (bars_.size() > maxBars_) bars_.pop_front();
}

void CandleSeries::addTrade(std::int64_t tsMs, Price price, Qty qty) {
  if (price <= 0 || qty <= 0) return;
  const auto start = bucketStart(tsMs, intervalMs_);

  if (bars_.empty() || start > bars_.back().start) {
    bars_.push_back({start, price, price, price, price, qty});
    trim();
    ++version_;
    return;
  }

  // 마지막 봉 또는 그 이전 봉(늦게 도착한 체결)
  auto it = std::lower_bound(bars_.begin(), bars_.end(), start,
                             [](const Candle& c, std::int64_t s) { return c.start < s; });
  if (it == bars_.end() || it->start != start) {
    if (it == bars_.begin() && bars_.size() >= maxBars_) return;  // 보관 범위보다 오래됨
    bars_.insert(it, {start, price, price, price, price, qty});
    trim();
    ++version_;
    return;
  }
  auto& bar = *it;
  bar.high = std::max(bar.high, price);
  bar.low = std::min(bar.low, price);
  // 늦게 온 체결이 그 봉의 마지막 체결이라는 보장은 없지만, 마지막 봉이면 종가로 본다.
  if (&bar == &bars_.back()) bar.close = price;
  bar.volume += qty;
  ++version_;
}

void CandleSeries::mergeHistory(std::span<const Candle> history) {
  std::deque<Candle> merged(history.begin(), history.end());
  std::sort(merged.begin(), merged.end(), [](const Candle& a, const Candle& b) { return a.start < b.start; });
  const auto lastHistory = merged.empty() ? std::numeric_limits<std::int64_t>::min() : merged.back().start;
  for (const auto& bar : bars_) {
    if (bar.start > lastHistory) merged.push_back(bar);
  }
  bars_ = std::move(merged);
  trim();
  ++version_;
}

void CandleSeries::clear() {
  bars_.clear();
  ++version_;
}

std::vector<Candle> CandleSeries::bars(std::size_t limit, std::int64_t bucketMs) const {
  std::vector<Candle> out;
  if (limit == 0 || bars_.empty()) return out;

  if (bucketMs <= intervalMs_ || bucketMs % intervalMs_ != 0) {
    const auto n = std::min(limit, bars_.size());
    out.assign(bars_.end() - static_cast<std::ptrdiff_t>(n), bars_.end());
    return out;
  }

  // 긴 구간: 뒤에서부터 묶는다(필요한 만큼만)
  for (auto it = bars_.rbegin(); it != bars_.rend(); ++it) {
    const auto start = bucketStart(it->start, bucketMs);
    if (out.empty() || out.back().start != start) {
      if (out.size() == limit) break;
      out.push_back({start, it->open, it->high, it->low, it->close, it->volume});
    } else {
      auto& agg = out.back();
      agg.open = it->open;  // 거꾸로 가므로 마지막에 덮인 값이 가장 이른 봉의 시가
      agg.high = std::max(agg.high, it->high);
      agg.low = std::min(agg.low, it->low);
      agg.volume += it->volume;
    }
  }
  std::reverse(out.begin(), out.end());
  return out;
}

}  // namespace hoga
