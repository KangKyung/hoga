#pragma once

#include <cstdint>

namespace hoga {

// 가격과 수량은 부동소수점 오차를 피하려고 정수로만 다룬다. 가격 단위는 원.
using Price = std::int64_t;
using Qty = std::int64_t;
// 종목별 시세 메시지 순서 번호. 1씩 증가한다.
using Seq = std::uint64_t;
using OrderId = std::uint64_t;

enum class Side : std::uint8_t { Bid, Ask };

constexpr Side opposite(Side side) noexcept { return side == Side::Bid ? Side::Ask : Side::Bid; }

// 한 가격대의 합계 잔량(L2).
struct Level {
  Price price{0};
  Qty qty{0};
  friend bool operator==(const Level&, const Level&) = default;
};

}  // namespace hoga
