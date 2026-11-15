#include "hoga/chart_layout.hpp"

#include <algorithm>
#include <cmath>

#include "hoga/core.hpp"

namespace hoga::chart {

Window clampWindow(Window window, std::size_t barCount, int minBars, int maxBars) {
  window.visibleBars = std::clamp(window.visibleBars, minBars, maxBars);
  const int n = static_cast<int>(barCount);
  // 스크롤은 첫 봉이 화면 왼쪽 끝에 올 때까지만
  const int maxOffset = std::max(0, n - std::min(window.visibleBars, n));
  window.offset = std::clamp(window.offset, 0, maxOffset);
  return window;
}

std::vector<std::optional<double>> movingAverage(std::span<const Candle> bars, std::size_t n) {
  std::vector<std::optional<double>> out(bars.size());
  if (n == 0) return out;
  double sum = 0;
  for (std::size_t i = 0; i < bars.size(); ++i) {
    sum += static_cast<double>(bars[i].close);
    if (i >= n) sum -= static_cast<double>(bars[i - n].close);
    if (i + 1 >= n) out[i] = sum / static_cast<double>(n);
  }
  return out;
}

namespace {

// 보기 좋은 눈금 간격: 1·2·5 × 10^k, 그리고 호가단위의 배수
Price niceStep(double range, int targetLines, Price tick) {
  const double raw = range / std::max(1, targetLines);
  const double magnitude = std::pow(10.0, std::floor(std::log10(std::max(raw, 1.0))));
  double step = magnitude;
  for (double m : {1.0, 2.0, 5.0, 10.0}) {
    if (magnitude * m >= raw) {
      step = magnitude * m;
      break;
    }
  }
  auto s = static_cast<Price>(std::llround(step));
  if (tick > 0) s = std::max(tick, (s / tick) * tick);
  return std::max<Price>(1, s);
}

}  // namespace

Layout layout(std::span<const Candle> bars, const Viewport& vp, Window window, bool showMA) {
  Layout out;
  const bool showVolume = vp.volumeRatio > 0;
  out.plotRight = std::max(0.0F, vp.width - vp.rightAxis);
  const float plotBottom = std::max(0.0F, vp.height - vp.bottomAxis);
  const float volumeHeight = showVolume ? plotBottom * vp.volumeRatio : 0;
  out.priceTop = 4;
  out.priceBottom = std::max(out.priceTop + 1, plotBottom - volumeHeight - (showVolume ? vp.gap : 0));
  out.volumeTop = plotBottom - volumeHeight;
  out.volumeBottom = plotBottom;

  if (bars.empty() || out.plotRight <= 0) return out;

  window = clampWindow(window, bars.size());
  const int n = static_cast<int>(bars.size());
  const int end = n - window.offset;  // 화면 마지막 봉 다음 인덱스
  const int count = std::min(window.visibleBars, end);
  const int first = end - count;
  out.firstIndex = first;
  out.count = count;

  // 화면 칸 수는 visibleBars로 고정 → 봉이 적어도 폭이 갑자기 커지지 않고 오른쪽부터 채운다
  const float spacing = out.plotRight / static_cast<float>(window.visibleBars);
  const float bodyWidth = std::max(1.0F, spacing * 0.7F);
  const float leftPad = out.plotRight - spacing * static_cast<float>(count);
  auto xAt = [&](int i) { return leftPad + (static_cast<float>(i - first) + 0.5F) * spacing; };

  const auto ma5 = showMA ? movingAverage(bars, 5) : std::vector<std::optional<double>>{};
  const auto ma20 = showMA ? movingAverage(bars, 20) : std::vector<std::optional<double>>{};

  // 가격 범위: 보이는 봉의 고가·저가 + 이동평균
  double hi = 0, lo = 0;
  Qty maxVolume = 1;
  for (int i = first; i < end; ++i) {
    const auto& c = bars[static_cast<std::size_t>(i)];
    if (i == first) {
      hi = static_cast<double>(c.high);
      lo = static_cast<double>(c.low);
    }
    hi = std::max(hi, static_cast<double>(c.high));
    lo = std::min(lo, static_cast<double>(c.low));
    for (const auto* ma : {&ma5, &ma20}) {
      if (!ma->empty() && (*ma)[static_cast<std::size_t>(i)]) {
        hi = std::max(hi, *(*ma)[static_cast<std::size_t>(i)]);
        lo = std::min(lo, *(*ma)[static_cast<std::size_t>(i)]);
      }
    }
    maxVolume = std::max(maxVolume, c.volume);
  }
  const Price tick = std::max<Price>(1, tickSize(static_cast<Price>(std::llround(hi))));
  if (hi - lo < static_cast<double>(tick)) {
    hi += static_cast<double>(tick);
    lo -= static_cast<double>(tick);
  }
  const double pad = (hi - lo) * 0.06;
  hi += pad;
  lo -= pad;
  const float priceHeight = out.priceBottom - out.priceTop;
  auto yAt = [&](double price) {
    return out.priceTop + static_cast<float>((hi - price) / (hi - lo)) * priceHeight;
  };
  const float volumeSpan = out.volumeBottom - out.volumeTop;

  out.candles.reserve(static_cast<std::size_t>(count));
  for (int i = first; i < end; ++i) {
    const auto& c = bars[static_cast<std::size_t>(i)];
    CandleShape s;
    s.x = xAt(i);
    s.width = bodyWidth;
    s.up = c.close >= c.open;
    const auto top = static_cast<double>(std::max(c.open, c.close));
    const auto bottom = static_cast<double>(std::min(c.open, c.close));
    s.bodyTop = yAt(top);
    s.bodyBottom = std::max(yAt(bottom), s.bodyTop + 1.0F);  // 시가=종가여도 1단위는 보이게
    s.wickTop = yAt(static_cast<double>(c.high));
    s.wickBottom = yAt(static_cast<double>(c.low));
    s.volumeBottom = out.volumeBottom;
    s.volumeTop = out.volumeBottom -
                  (showVolume ? volumeSpan * static_cast<float>(c.volume) / static_cast<float>(maxVolume) : 0);
    out.candles.push_back(s);

    if (showMA) {
      if (ma5[static_cast<std::size_t>(i)]) out.ma5.push_back({s.x, yAt(*ma5[static_cast<std::size_t>(i)])});
      if (ma20[static_cast<std::size_t>(i)]) out.ma20.push_back({s.x, yAt(*ma20[static_cast<std::size_t>(i)])});
    }
  }

  // 가격 눈금
  const Price step = niceStep(hi - lo, 4, tick);
  for (Price p = static_cast<Price>(std::ceil(lo / static_cast<double>(step))) * step;
       static_cast<double>(p) <= hi; p += step) {
    out.grid.push_back({yAt(static_cast<double>(p)), p});
  }

  // 시간 눈금: 대략 4칸마다 하나
  const int every = std::max(1, count / 4);
  for (int i = first; i < end; i += every) {
    out.times.push_back({xAt(i), bars[static_cast<std::size_t>(i)].start});
  }

  if (window.offset == 0) {
    const auto lastClose = bars.back().close;
    out.last = GridLine{yAt(static_cast<double>(lastClose)), lastClose};
    // 마지막가 표시와 겹치는 눈금 글자는 뺀다
    const float minGap = vp.labelHeight;
    std::erase_if(out.grid, [&](const GridLine& g) { return std::abs(g.y - out.last->y) < minGap; });
  }
  return out;
}

std::optional<std::size_t> indexAt(const Layout& layout, float x) {
  if (layout.count == 0 || layout.candles.empty() || x < 0 || x > layout.plotRight) return std::nullopt;
  // 가장 가까운 봉 중심
  std::size_t best = 0;
  float bestDist = std::abs(layout.candles[0].x - x);
  for (std::size_t i = 1; i < layout.candles.size(); ++i) {
    const float d = std::abs(layout.candles[i].x - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return static_cast<std::size_t>(layout.firstIndex) + best;
}

}  // namespace hoga::chart
