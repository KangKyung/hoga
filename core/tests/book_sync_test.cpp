#include <gtest/gtest.h>

#include <vector>

#include "hoga/book_sync.hpp"

using hoga::BookSync;
using hoga::Delta;
using hoga::Level;
using hoga::Side;
using hoga::SyncEvent;
using hoga::SyncState;

namespace {

Delta bid(hoga::Seq seq, hoga::Price price, hoga::Qty qty) { return {seq, Side::Bid, price, qty}; }

const std::vector<Level> kBids{{100, 10}};
const std::vector<Level> kAsks{{110, 10}};

}  // namespace

TEST(BookSync, BuffersUntilFirstSnapshot) {
  BookSync sync;
  EXPECT_EQ(sync.state(), SyncState::WaitingSnapshot);
  EXPECT_EQ(sync.onDelta(bid(5, 100, 11)), SyncEvent::Buffered);
  EXPECT_EQ(sync.onDelta(bid(6, 100, 12)), SyncEvent::Buffered);

  // 스냅샷 seq 5 → 버퍼의 5는 버리고 6부터 반영
  EXPECT_EQ(sync.onSnapshot(5, kBids, kAsks), SyncEvent::Synced);
  EXPECT_EQ(sync.state(), SyncState::Live);
  EXPECT_EQ(sync.book().top(Side::Bid, 1), (std::vector<Level>{{100, 12}}));
  EXPECT_EQ(sync.book().seq(), 6u);
  EXPECT_EQ(sync.bufferedCount(), 0u);
}

TEST(BookSync, GapTriggersResyncOnce) {
  BookSync sync;
  sync.onSnapshot(10, kBids, kAsks);
  EXPECT_EQ(sync.onDelta(bid(11, 100, 20)), SyncEvent::Applied);

  // 12가 빠지고 13이 옴
  EXPECT_EQ(sync.onDelta(bid(13, 100, 30)), SyncEvent::NeedSnapshot);
  EXPECT_EQ(sync.state(), SyncState::Resyncing);
  // 그 다음부터는 요청 없이 쌓기만 한다
  EXPECT_EQ(sync.onDelta(bid(14, 100, 40)), SyncEvent::Buffered);

  // 스냅샷 seq 13 → 14만 이어서 반영
  EXPECT_EQ(sync.onSnapshot(13, std::vector<Level>{{100, 30}}, kAsks), SyncEvent::Synced);
  EXPECT_EQ(sync.book().top(Side::Bid, 1), (std::vector<Level>{{100, 40}}));
  EXPECT_EQ(sync.book().seq(), 14u);
}

TEST(BookSync, SnapshotThatLeavesAGapAsksAgain) {
  BookSync sync;
  sync.onSnapshot(10, kBids, kAsks);
  sync.onDelta(bid(15, 100, 1));  // gap → resync, 15 보관
  // 스냅샷이 12까지라서 13~14가 비어 있다
  EXPECT_EQ(sync.onSnapshot(12, kBids, kAsks), SyncEvent::NeedSnapshot);
  EXPECT_EQ(sync.state(), SyncState::Resyncing);
  EXPECT_EQ(sync.bufferedCount(), 1u);
  EXPECT_EQ(sync.onSnapshot(14, kBids, kAsks), SyncEvent::Synced);
  EXPECT_EQ(sync.book().seq(), 15u);
}

TEST(BookSync, DuplicatesAreIgnoredWhileLive) {
  BookSync sync;
  sync.onSnapshot(10, kBids, kAsks);
  EXPECT_EQ(sync.onDelta(bid(10, 100, 99)), SyncEvent::Ignored);
  EXPECT_EQ(sync.book().top(Side::Bid, 1), (std::vector<Level>{{100, 10}}));
}

TEST(BookSync, OutOfOrderBufferIsSorted) {
  BookSync sync;
  sync.onDelta(bid(3, 100, 3));
  sync.onDelta(bid(2, 100, 2));
  EXPECT_EQ(sync.onSnapshot(1, kBids, kAsks), SyncEvent::Synced);
  EXPECT_EQ(sync.book().top(Side::Bid, 1), (std::vector<Level>{{100, 3}}));
}

TEST(BookSync, OldSnapshotIgnoredWhenLive) {
  BookSync sync;
  sync.onSnapshot(10, kBids, kAsks);
  sync.onDelta(bid(11, 100, 20));
  EXPECT_EQ(sync.onSnapshot(9, std::vector<Level>{{100, 1}}, kAsks), SyncEvent::Ignored);
  EXPECT_EQ(sync.book().seq(), 11u);
}

TEST(BookSync, BufferOverflowDropsOldest) {
  BookSync sync(3);
  for (hoga::Seq s = 1; s <= 5; ++s) sync.onDelta(bid(s, 100, static_cast<hoga::Qty>(s)));
  EXPECT_EQ(sync.bufferedCount(), 3u);
  EXPECT_EQ(sync.droppedCount(), 2u);
  // 버린 1~2는 스냅샷(seq 2)이 덮으므로 3~5로 이어진다
  EXPECT_EQ(sync.onSnapshot(2, kBids, kAsks), SyncEvent::Synced);
  EXPECT_EQ(sync.book().seq(), 5u);
}

TEST(BookSync, ResetStartsOver) {
  BookSync sync;
  sync.onSnapshot(10, kBids, kAsks);
  sync.reset();
  EXPECT_EQ(sync.state(), SyncState::WaitingSnapshot);
  EXPECT_FALSE(sync.book().hasSnapshot());
}
