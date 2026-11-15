#pragma once

#include <string_view>

#include "hoga/types.hpp"

namespace hoga {

// 코어 라이브러리 버전. 앱·서버가 같은 코어를 쓰는지 확인하는 용도.
std::string_view coreVersion() noexcept;

// 국내 주식 호가가격단위(원).
// 0 이하 가격은 유효하지 않으므로 0을 돌려준다.
// TODO: KRX 최신 규정 원문으로 표를 다시 확인하고 출처를 README에 남긴다.
Price tickSize(Price price) noexcept;

enum class Round : std::uint8_t { Down, Up };

// 가격이 호가단위에 맞는지.
bool isOnTick(Price price) noexcept;

// 호가단위에 맞게 내림/올림. 올림 결과가 다음 가격대로 넘어가도 그 가격대의 단위에 맞는다.
// 0 이하 가격은 0.
Price roundToTick(Price price, Round mode) noexcept;

// 가격제한폭(상·하한가).
struct PriceBand {
  Price lower{0};
  Price upper{0};
  friend bool operator==(const PriceBand&, const PriceBand&) = default;
};

// 기준가 ±30%. 폭은 기준가의 호가단위 미만을 버리고, 상한가는 내림·하한가는 올림으로 단위에 맞춘다.
// TODO: KRX 규정 원문과 대조 필요(간소화한 규칙).
PriceBand priceLimits(Price basePrice) noexcept;

}  // namespace hoga
