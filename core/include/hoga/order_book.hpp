#pragma once

#include <cstddef>
#include <functional>
#include <map>
#include <optional>
#include <shared_mutex>
#include <span>
#include <vector>

#include "hoga/types.hpp"

namespace hoga {

enum class ApplyResult : std::uint8_t {
  Applied,  // 정상 반영
  Stale,    // 이미 반영한 seq (중복 수신) → 무시
  Gap,      // seq가 건너뜀 또는 스냅샷 전 → 반영하지 않음, 재동기화 필요
  Invalid,  // 가격·수량이 잘못됨 → 반영하지 않음
};

// 가격대별 합계 잔량(L2) 호가창.
// 쓰기는 한 스레드(소켓 수신)에서, 읽기는 여러 스레드(JS·UI)에서 해도 안전하다.
class OrderBook {
 public:
  void applySnapshot(Seq seq, std::span<const Level> bids, std::span<const Level> asks);
  // qty == 0이면 해당 가격대를 지운다.
  ApplyResult applyDelta(Seq seq, Side side, Price price, Qty qty);
  void clear();

  // 최우선 호가부터 n단계. 매수는 높은 가격부터, 매도는 낮은 가격부터.
  std::vector<Level> top(Side side, std::size_t depth) const;
  std::optional<Price> bestBid() const;
  std::optional<Price> bestAsk() const;
  Seq seq() const;
  bool hasSnapshot() const;

 private:
  mutable std::shared_mutex mutex_;
  std::map<Price, Qty, std::greater<>> bids_;
  std::map<Price, Qty> asks_;
  Seq seq_{0};
  bool hasSnapshot_{false};
};

}  // namespace hoga
