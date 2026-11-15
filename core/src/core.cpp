#include "hoga/core.hpp"

#include <array>

namespace hoga {

namespace {

struct TickBand {
  Price upperExclusive;  // 이 가격 미만까지 적용
  Price tick;
};

// 2023년 개편된 유가증권·코스닥 공통 호가가격단위(M1에서 원문 재확인 예정).
constexpr std::array<TickBand, 6> kBands{{
    {2'000, 1},
    {5'000, 5},
    {20'000, 10},
    {50'000, 50},
    {200'000, 100},
    {500'000, 500},
}};

constexpr Price kTopTick = 1'000;

}  // namespace

std::string_view coreVersion() noexcept { return "0.0.1-m0"; }

Price tickSize(Price price) noexcept {
  if (price <= 0) return 0;
  for (const auto& band : kBands) {
    if (price < band.upperExclusive) return band.tick;
  }
  return kTopTick;
}

}  // namespace hoga
