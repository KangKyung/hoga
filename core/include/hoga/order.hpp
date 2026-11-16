#pragma once

#include <cstdint>
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
  ExceedsOpenQty,   // 정정·취소 수량이 미체결 잔량보다 많음
  MarketClosed,     // 장 종료(접수 안 함)
  MarketInAuction,  // 단일가(동시호가·VI) 중 시장가 주문(이 모의 거래소는 지정가만 받는다)
  InsufficientCash, // 주문가능금액 부족
  InsufficientQty,  // 매도가능수량 부족
};

std::string_view toString(RejectReason reason) noexcept;

struct ValidationPolicy {
  Price basePrice{0};      // 가격제한폭 계산 기준가(전일 종가 등)
  Qty maxQty{1'000'000};   // 1회 주문 최대 수량
};

// 앱(주문 화면)과 서버(주문 접수)가 같은 규칙을 쓰도록 공용 검증 함수로 둔다.
RejectReason validateOrder(const OrderRequest& order, const ValidationPolicy& policy) noexcept;

// ---- 계좌 기준 검증(주문가능금액·매도가능수량) ----
// 앱(주문가능 수량 표시·사전 검증)과 서버(접수 전 확인)가 같은 규칙을 쓴다.

using Money = std::int64_t;  // 원

struct AccountLimits {
  Money availableCash{0};  // 주문가능금액 = 예수금 - 미체결 매수 증거금
  Qty sellableQty{0};      // 매도가능수량 = 보유 - 미체결 매도
};

// 매수 주문이 묶어 두는 1주당 금액. 지정가는 주문가, 시장가는 체결가를 모르므로 상한가로 잡는다.
Price reservePrice(const OrderRequest& order, Price upperLimit) noexcept;

// 계좌 한도를 넘으면 InsufficientCash / InsufficientQty
RejectReason checkAccount(const OrderRequest& order, const AccountLimits& limits, Price upperLimit) noexcept;

// 지금 한도로 낼 수 있는 최대 수량(주문 화면의 "최대"). 가격이 0 이하인 지정가 매수는 0.
Qty maxOrderQty(Side side, OrderType type, Price price, const AccountLimits& limits, Price upperLimit,
                Qty maxQty) noexcept;

}  // namespace hoga
