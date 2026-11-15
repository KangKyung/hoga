#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

#include "hoga/candles.hpp"

namespace hoga::chart {

/**
 * 캔들 차트 배치 계산(플랫폼 공용).
 *
 * iOS(CoreGraphics)·Android(Canvas)는 여기서 나온 좌표대로 사각형·선·글자만 그린다.
 * 보이는 구간, 가격 범위, 이동평균, 격자, 거래량, 십자선 위치 계산이 한 벌이라
 * 두 플랫폼의 차트가 같은 값을 보여 주고, 계산은 단위 테스트로 검증한다.
 * 좌표 단위는 플랫폼 단위(iOS pt, Android px) 그대로 쓴다.
 */
struct Viewport {
  float width{0};
  float height{0};
  float rightAxis{56};      // 오른쪽 가격 눈금 영역 폭
  float bottomAxis{18};     // 아래 시간 눈금 영역 높이
  float volumeRatio{0.22F}; // 거래량 영역 비율(0이면 거래량 숨김)
  float gap{6};             // 가격·거래량 영역 사이 간격
  float labelHeight{16};    // 가격 글자(마지막가 표시) 높이. 이보다 가까운 눈금 글자는 겹치므로 뺀다
};

struct Window {
  int visibleBars{60};  // 화면에 보일 봉 수(확대·축소)
  int offset{0};        // 최신 봉에서 몇 개 이전까지 밀었는지(스크롤), 0 = 최신이 오른쪽 끝
};

struct CandleShape {
  float x{0};           // 봉 중심
  float width{0};
  float bodyTop{0};
  float bodyBottom{0};
  float wickTop{0};
  float wickBottom{0};
  float volumeTop{0};
  float volumeBottom{0};
  bool up{false};       // 종가 >= 시가 (국내 관례: 빨강)
};

struct Point {
  float x{0};
  float y{0};
};

struct GridLine {
  float y{0};
  Price price{0};
};

struct TimeLabel {
  float x{0};
  std::int64_t time{0};
};

struct Layout {
  std::vector<CandleShape> candles;
  std::vector<Point> ma5;
  std::vector<Point> ma20;
  std::vector<GridLine> grid;
  std::vector<TimeLabel> times;
  // 마지막 체결가 선(보이는 구간에 마지막 봉이 있을 때만)
  std::optional<GridLine> last;
  float plotRight{0};
  float priceTop{0};
  float priceBottom{0};
  float volumeTop{0};
  float volumeBottom{0};
  int firstIndex{0};  // bars에서 화면 첫 봉의 인덱스
  int count{0};       // 화면에 그린 봉 수
};

// 확대·스크롤 범위를 bars 개수에 맞게 보정한다.
Window clampWindow(Window window, std::size_t barCount, int minBars = 15, int maxBars = 300);

Layout layout(std::span<const Candle> bars, const Viewport& viewport, Window window, bool showMA);

// 화면 x 좌표의 봉 인덱스(bars 기준). 봉이 없거나 그래프 밖이면 nullopt.
std::optional<std::size_t> indexAt(const Layout& layout, float x);

// n개 종가 단순 이동평균. 처음 n-1개는 값이 없다.
std::vector<std::optional<double>> movingAverage(std::span<const Candle> bars, std::size_t n);

}  // namespace hoga::chart
