#pragma once

#include <atomic>
#include <cstddef>
#include <span>
#include <vector>

#include "hoga/order_book.hpp"

namespace hoga {

struct Delta {
  Seq seq{0};
  Side side{Side::Bid};
  Price price{0};
  Qty qty{0};
};

enum class SyncState : std::uint8_t {
  WaitingSnapshot,  // 처음 스냅샷을 기다리는 중
  Live,             // 정상: 변경분을 바로 반영
  Resyncing,        // seq 누락 감지 → 변경분을 쌓아 두고 스냅샷을 기다리는 중
};

enum class SyncEvent : std::uint8_t {
  Applied,       // 변경분 반영
  Buffered,      // 스냅샷 대기 중이라 쌓아 둠
  Ignored,       // 중복·오래된 메시지
  NeedSnapshot,  // 호출자는 스냅샷을 요청해야 한다 (상태가 바뀐 순간에 한 번만)
  Synced,        // 스냅샷 + 쌓아 둔 변경분까지 반영 완료
};

// 스냅샷 + 변경분 스트림을 seq로 이어 붙이는 상태 머신.
//
// 재동기화 절차:
//   1) Live 중 gap 발견 → Resyncing, 해당 변경분부터 버퍼에 보관, NeedSnapshot 반환
//   2) 이후 변경분은 버퍼에 계속 보관
//   3) 스냅샷(seq = S) 도착 → 버퍼에서 seq <= S는 버리고 S+1부터 이어서 반영
//   4) 버퍼 안에서도 끊기면 남은 것만 보관한 채 다시 NeedSnapshot
//
// 쓰기(onDelta/onSnapshot)는 한 스레드에서만 호출한다. book() 읽기는 다른 스레드에서도 안전하다.
class BookSync {
 public:
  explicit BookSync(std::size_t maxBuffered = 10'000);

  SyncEvent onDelta(const Delta& delta);
  SyncEvent onSnapshot(Seq seq, std::span<const Level> bids, std::span<const Level> asks);

  // 연결이 끊겼을 때: 호가를 비우고 처음 스냅샷부터 다시.
  void reset();

  SyncState state() const noexcept { return state_.load(std::memory_order_acquire); }
  const OrderBook& book() const noexcept { return book_; }
  std::size_t bufferedCount() const noexcept { return buffer_.size(); }
  // 버퍼가 넘쳐 버린 변경분 수 (관측용)
  std::size_t droppedCount() const noexcept { return dropped_; }

 private:
  SyncEvent startResync(const Delta& delta);
  void buffer(const Delta& delta);
  void setState(SyncState state) noexcept { state_.store(state, std::memory_order_release); }

  OrderBook book_;
  std::vector<Delta> buffer_;
  std::size_t maxBuffered_;
  std::size_t dropped_{0};
  std::atomic<SyncState> state_{SyncState::WaitingSnapshot};
};

}  // namespace hoga
