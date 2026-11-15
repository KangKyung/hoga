#include "hoga/core.hpp"

#include <array>

namespace hoga {

namespace {

struct TickBand {
  Price upperExclusive;  // 이 가격 미만까지 적용
  Price tick;
};

// 2023년 개편된 유가증권·코스닥 공통 호가가격단위(규정 원문 재확인 예정).
// 각 경계값은 아래·위 가격대 단위 모두의 배수라서 올림 결과가 항상 단위에 맞는다.
constexpr std::array<TickBand, 6> kBands{{
    {2'000, 1},
    {5'000, 5},
    {20'000, 10},
    {50'000, 50},
    {200'000, 100},
    {500'000, 500},
}};

constexpr Price kTopTick = 1'000;
constexpr Price kLimitPercent = 30;

}  // namespace

std::string_view coreVersion() noexcept { return "0.1.0-m1"; }

Price tickSize(Price price) noexcept {
  if (price <= 0) return 0;
  for (const auto& band : kBands) {
    if (price < band.upperExclusive) return band.tick;
  }
  return kTopTick;
}

bool isOnTick(Price price) noexcept { return price > 0 && price % tickSize(price) == 0; }

Price roundToTick(Price price, Round mode) noexcept {
  if (price <= 0) return 0;
  const Price tick = tickSize(price);
  const Price remainder = price % tick;
  if (remainder == 0) return price;
  const Price down = price - remainder;
  return mode == Round::Down ? down : down + tick;
}

PriceBand priceLimits(Price basePrice) noexcept {
  if (basePrice <= 0) return {};
  const Price baseTick = tickSize(basePrice);
  Price width = basePrice * kLimitPercent / 100;
  width -= width % baseTick;

  const Price upper = roundToTick(basePrice + width, Round::Down);
  Price lower = roundToTick(basePrice - width, Round::Up);
  if (lower < 1) lower = 1;
  return {lower, upper};
}

}  // namespace hoga
