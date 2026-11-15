#include <gtest/gtest.h>

#include <atomic>
#include <thread>
#include <vector>

#include "hoga/order_book.hpp"

using hoga::ApplyResult;
using hoga::Level;
using hoga::OrderBook;
using hoga::Side;

namespace {

// OrderBook은 뮤텍스를 가지므로 복사·이동이 안 된다 → 참조로 채운다.
void fillBook(OrderBook& book) {
  const std::vector<Level> bids{{71'100, 300}, {71'200, 100}, {71'000, 50}};
  const std::vector<Level> asks{{71'400, 80}, {71'300, 120}};
  book.applySnapshot(10, bids, asks);
}

}  // namespace

TEST(OrderBook, SnapshotSortsLevels) {
  OrderBook book;
  fillBook(book);
  EXPECT_EQ(book.top(Side::Bid, 10), (std::vector<Level>{{71'200, 100}, {71'100, 300}, {71'000, 50}}));
  EXPECT_EQ(book.top(Side::Ask, 10), (std::vector<Level>{{71'300, 120}, {71'400, 80}}));
  EXPECT_EQ(book.bestBid(), 71'200);
  EXPECT_EQ(book.bestAsk(), 71'300);
  EXPECT_EQ(book.seq(), 10u);
}

TEST(OrderBook, TopRespectsDepth) {
  OrderBook book;
  fillBook(book);
  EXPECT_EQ(book.top(Side::Bid, 2).size(), 2u);
}

TEST(OrderBook, DeltaUpdatesAndRemoves) {
  OrderBook book;
  fillBook(book);
  EXPECT_EQ(book.applyDelta(11, Side::Bid, 71'200, 90), ApplyResult::Applied);
  EXPECT_EQ(book.applyDelta(12, Side::Ask, 71'300, 0), ApplyResult::Applied);
  EXPECT_EQ(book.top(Side::Bid, 1), (std::vector<Level>{{71'200, 90}}));
  EXPECT_EQ(book.bestAsk(), 71'400);
  EXPECT_EQ(book.seq(), 12u);
}

TEST(OrderBook, StaleAndGapAreNotApplied) {
  OrderBook book;
  fillBook(book);
  EXPECT_EQ(book.applyDelta(10, Side::Bid, 71'200, 1), ApplyResult::Stale);
  EXPECT_EQ(book.applyDelta(12, Side::Bid, 71'200, 1), ApplyResult::Gap);
  EXPECT_EQ(book.top(Side::Bid, 1), (std::vector<Level>{{71'200, 100}}));
  EXPECT_EQ(book.seq(), 10u);
}

TEST(OrderBook, DeltaBeforeSnapshotIsGap) {
  OrderBook book;
  EXPECT_EQ(book.applyDelta(1, Side::Bid, 100, 1), ApplyResult::Gap);
}

TEST(OrderBook, InvalidDeltaIsRejected) {
  OrderBook book;
  fillBook(book);
  EXPECT_EQ(book.applyDelta(11, Side::Bid, 0, 1), ApplyResult::Invalid);
  EXPECT_EQ(book.applyDelta(11, Side::Bid, 100, -1), ApplyResult::Invalid);
  EXPECT_EQ(book.seq(), 10u);
}

// 쓰기 1 · 읽기 4 동시 실행. ThreadSanitizer 빌드(HOGA_SANITIZE=thread)에서 데이터 경쟁이 없어야 한다.
TEST(OrderBook, ConcurrentReadersAndSingleWriter) {
  OrderBook book;
  book.applySnapshot(0, {}, {});
  std::atomic<bool> done{false};

  std::vector<std::thread> readers;
  for (int r = 0; r < 4; ++r) {
    readers.emplace_back([&] {
      while (!done.load()) {
        const auto bids = book.top(Side::Bid, 10);
        for (std::size_t i = 1; i < bids.size(); ++i) {
          ASSERT_GT(bids[i - 1].price, bids[i].price);
        }
      }
    });
  }

  for (hoga::Seq seq = 1; seq <= 20'000; ++seq) {
    const auto price = static_cast<hoga::Price>(70'000 + (seq % 50) * 100);
    ASSERT_EQ(book.applyDelta(seq, Side::Bid, price, static_cast<hoga::Qty>(seq % 7)),
              ApplyResult::Applied);
  }
  done = true;
  for (auto& t : readers) t.join();
  EXPECT_EQ(book.seq(), 20'000u);
}
