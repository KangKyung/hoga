#pragma once

#include <cstddef>
#include <deque>
#include <functional>
#include <map>
#include <optional>
#include <unordered_map>
#include <vector>

#include "hoga/order.hpp"

namespace hoga {

struct Fill {
  OrderId taker{0};
  OrderId maker{0};
  Side takerSide{Side::Bid};
  Price price{0};  // 체결가 = 먼저 걸려 있던(maker) 주문의 가격
  Qty qty{0};
};

// 한 가격대의 잔량이 바뀐 결과. qty == 0이면 그 가격대가 사라졌다.
// 서버는 이것을 그대로 시세 변경분(delta)으로 내보낸다.
struct LevelChange {
  Side side{Side::Bid};
  Price price{0};
  Qty qty{0};
  friend bool operator==(const LevelChange&, const LevelChange&) = default;
};

enum class OrderStatus : std::uint8_t {
  New,              // 접수, 체결 없음, 호가창에 대기
  PartiallyFilled,  // 일부 체결
  Filled,           // 전량 체결
  Cancelled,        // 취소(시장가 미체결 잔량 포함)
  Rejected,         // 거부
};

std::string_view toString(OrderStatus status) noexcept;

struct ExecutionResult {
  OrderId id{0};
  OrderStatus status{OrderStatus::Rejected};
  RejectReason reject{RejectReason::None};
  Qty filled{0};
  Qty resting{0};  // 호가창에 남아 있는 수량
  std::vector<Fill> fills;
  std::vector<LevelChange> changes;
};

// 한 종목의 가격·시간 우선 매칭 엔진.
// 결정적(같은 입력 → 같은 출력)이어야 하므로 한 스레드(단일 작성자)에서만 호출한다.
class MatchingEngine {
 public:
  explicit MatchingEngine(ValidationPolicy policy);

  ExecutionResult submit(const OrderRequest& order);
  ExecutionResult cancel(OrderId id);

  std::vector<Level> depth(Side side, std::size_t levels) const;
  std::optional<Price> lastPrice() const noexcept { return lastPrice_; }
  const ValidationPolicy& policy() const noexcept { return policy_; }
  std::size_t restingOrderCount() const noexcept { return index_.size(); }

 private:
  struct Resting {
    OrderId id;
    Qty remaining;
  };
  struct LevelQueue {
    std::deque<Resting> orders;  // 먼저 들어온 주문이 앞(시간 우선)
    Qty total{0};
  };
  using BidMap = std::map<Price, LevelQueue, std::greater<>>;
  using AskMap = std::map<Price, LevelQueue>;

  template <typename BookMap>
  void matchAgainst(BookMap& book, Side makerSide, const OrderRequest& order, OrderId takerId,
                    ExecutionResult& result);
  template <typename BookMap>
  void rest(BookMap& book, Side side, Price price, OrderId id, Qty qty, ExecutionResult& result);

  static void recordChange(ExecutionResult& result, Side side, Price price, Qty qty);

  ValidationPolicy policy_;
  BidMap bids_;
  AskMap asks_;
  std::unordered_map<OrderId, std::pair<Side, Price>> index_;
  OrderId nextId_{1};
  std::optional<Price> lastPrice_;
};

}  // namespace hoga
