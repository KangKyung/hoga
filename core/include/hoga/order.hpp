#pragma once

#include <string_view>

#include "hoga/types.hpp"

namespace hoga {

enum class OrderType : std::uint8_t {
  Limit,   // 지정가: 남은 수량은 호가창에 남는다
  Market,  // 시장가: 즉시 체결 가능한 만큼만, 남은 수량은 취소
};

struct OrderRequest {
  Side side{Side::Bid};
  OrderType type{OrderType::Limit};
  Price price{0};  // 시장가는 0
  Qty qty{0};
};

enum class RejectReason : std::uint8_t {
  None,
  InvalidQty,       // 수량 0 이하
  QtyTooLarge,      // 1회 최대 수량 초과
  InvalidPrice,     // 지정가인데 가격 0 이하, 또는 시장가인데 가격이 있음
  OffTick,          // 호가단위에 맞지 않음
  OutOfPriceLimit,  // 상·하한가 범위 밖
  NoLiquidity,      // 시장가인데 반대편 호가가 없음
  UnknownOrder,     // 취소 대상 주문이 없음(이미 체결·취소됨)
};

std::string_view toString(RejectReason reason) noexcept;

struct ValidationPolicy {
  Price basePrice{0};      // 가격제한폭 계산 기준가(전일 종가 등)
  Qty maxQty{1'000'000};   // 1회 주문 최대 수량
};

// 앱(주문 화면)과 서버(주문 접수)가 같은 규칙을 쓰도록 공용 검증 함수로 둔다.
RejectReason validateOrder(const OrderRequest& order, const ValidationPolicy& policy) noexcept;

}  // namespace hoga
