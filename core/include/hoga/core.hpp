#pragma once

#include <cstdint>
#include <string_view>

namespace hoga {

// 가격과 수량은 부동소수점 오차를 피하려고 정수(원 단위)로만 다룬다.
using Price = std::int64_t;

// 코어 라이브러리 버전. 앱·서버가 같은 코어를 쓰는지 확인하는 용도.
std::string_view coreVersion() noexcept;

// 국내 주식 호가가격단위(원).
// 0 이하 가격은 유효하지 않으므로 0을 돌려준다.
// TODO(M1): KRX 최신 규정 원문으로 표를 다시 확인하고 출처를 README에 남긴다.
Price tickSize(Price price) noexcept;

}  // namespace hoga
