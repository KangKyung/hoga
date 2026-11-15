#include "hoga/book_sync.hpp"

#include <algorithm>

namespace hoga {

BookSync::BookSync(std::size_t maxBuffered) : maxBuffered_(maxBuffered == 0 ? 1 : maxBuffered) {}

void BookSync::buffer(const Delta& delta) {
  if (buffer_.size() >= maxBuffered_) {
    // 너무 오래 스냅샷이 오지 않으면 가장 오래된 것부터 버린다.
    // 버린 구간은 스냅샷이 덮으므로 정확성은 유지되고, 이어지지 않으면 다시 재동기화한다.
    buffer_.erase(buffer_.begin());
    ++dropped_;
  }
  buffer_.push_back(delta);
}

SyncEvent BookSync::startResync(const Delta& delta) {
  setState(SyncState::Resyncing);
  buffer_.clear();
  buffer(delta);
  return SyncEvent::NeedSnapshot;
}

SyncEvent BookSync::onDelta(const Delta& delta) {
  switch (state()) {
    case SyncState::WaitingSnapshot:
    case SyncState::Resyncing:
      buffer(delta);
      return SyncEvent::Buffered;

    case SyncState::Live:
      switch (book_.applyDelta(delta.seq, delta.side, delta.price, delta.qty)) {
        case ApplyResult::Applied:
          return SyncEvent::Applied;
        case ApplyResult::Stale:
        case ApplyResult::Invalid:
          return SyncEvent::Ignored;
        case ApplyResult::Gap:
          return startResync(delta);
      }
  }
  return SyncEvent::Ignored;
}

SyncEvent BookSync::onSnapshot(Seq seq, std::span<const Level> bids, std::span<const Level> asks) {
  // 이미 그보다 새로운 상태로 Live라면 오래된 스냅샷은 무시한다.
  if (state() == SyncState::Live && seq <= book_.seq()) return SyncEvent::Ignored;

  book_.applySnapshot(seq, bids, asks);

  std::sort(buffer_.begin(), buffer_.end(),
            [](const Delta& a, const Delta& b) { return a.seq < b.seq; });

  std::size_t i = 0;
  for (; i < buffer_.size(); ++i) {
    const auto& d = buffer_[i];
    if (d.seq <= seq) continue;
    const auto result = book_.applyDelta(d.seq, d.side, d.price, d.qty);
    if (result == ApplyResult::Gap) break;
  }

  if (i < buffer_.size()) {
    // 스냅샷 뒤로도 끊긴 구간이 있다 → 남은 변경분만 보관하고 다시 스냅샷 요청.
    buffer_.erase(buffer_.begin(), buffer_.begin() + static_cast<std::ptrdiff_t>(i));
    setState(SyncState::Resyncing);
    return SyncEvent::NeedSnapshot;
  }

  buffer_.clear();
  setState(SyncState::Live);
  return SyncEvent::Synced;
}

void BookSync::reset() {
  book_.clear();
  buffer_.clear();
  setState(SyncState::WaitingSnapshot);
}

}  // namespace hoga
