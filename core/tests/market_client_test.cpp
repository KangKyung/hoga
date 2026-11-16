#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <string>
#include <vector>

#include "hoga/market_client.hpp"
#include "hoga/wire.hpp"

using namespace std::chrono_literals;
using hoga::ConnectionState;
using hoga::Level;
using hoga::MarketClient;
using hoga::SyncState;

namespace {

// 콜백을 바로 부르지 않고 쌓아 두었다가 테스트가 원하는 순간에 실행하는 가짜 전송 계층.
class FakeTransport : public hoga::ITransport {
 public:
  struct Http {
    std::string url;
    std::function<void(int, std::string)> done;
  };
  struct Timer {
    std::chrono::milliseconds delay;
    std::function<void()> fn;
  };

  void connect(const std::string& url, hoga::TransportCallbacks callbacks) override {
    urls.push_back(url);
    cb = std::move(callbacks);
  }
  void send(const std::string& text) override { sent.push_back(text); }
  void close(int code, const std::string&) override { closedWith.push_back(code); }
  void httpGet(const std::string& url, std::function<void(int, std::string)> done) override {
    http.push_back({url, std::move(done)});
  }
  void schedule(std::chrono::milliseconds delay, std::function<void()> fn) override {
    timers.push_back({delay, std::move(fn)});
  }

  void open() { cb.onOpen(); }
  void message(const std::string& text) { cb.onMessage(text); }
  void serverClose(int code, const std::string& reason = "bye") { cb.onClose(code, reason); }
  void runTimers() {
    auto pending = std::move(timers);
    timers.clear();
    for (auto& t : pending) t.fn();
  }

  // 스냅샷(재동기화) 요청만. 연결 직후의 과거 봉(/candles) 요청은 제외한다.
  std::vector<Http*> snapshots() {
    std::vector<Http*> out;
    for (auto& h : http) {
      if (h.url.find("/book/") != std::string::npos) out.push_back(&h);
    }
    return out;
  }

  hoga::TransportCallbacks cb;
  std::vector<std::string> urls, sent;
  std::vector<int> closedWith;
  std::vector<Http> http;
  std::vector<Timer> timers;
};

std::string snap(hoga::Seq seq, hoga::Price bidPx, hoga::Qty bidQty) {
  return R"({"t":"snap","sym":"000001","seq":)" + std::to_string(seq) + R"(,"ts":0,"bids":[[)" +
         std::to_string(bidPx) + "," + std::to_string(bidQty) + R"(]],"asks":[[71300,5]]})";
}
std::string delta(hoga::Seq seq, hoga::Price px, hoga::Qty qty) {
  return R"({"t":"delta","sym":"000001","seq":)" + std::to_string(seq) + R"(,"ts":0,"side":"B","px":)" +
         std::to_string(px) + ",\"qty\":" + std::to_string(qty) + "}";
}

struct Fixture {
  std::shared_ptr<FakeTransport> transport = std::make_shared<FakeTransport>();
  std::vector<ConnectionState> states;
  std::shared_ptr<MarketClient> client;

  explicit Fixture(double random = 0.5) {
    hoga::MarketClientOptions options;
    options.wsUrl = "ws://test/ws";
    options.httpBaseUrl = "http://test";
    options.random = [random] { return random; };
    options.nowMs = [] { return 1'000; };
    client = MarketClient::create(transport, options,
                                  [this](ConnectionState s, std::uint32_t) { states.push_back(s); });
  }
};

}  // namespace

TEST(MarketClient, SubscribesOnOpenAndAppliesSnapshotThenDeltas) {
  Fixture f;
  f.client->subscribe({"000001"});
  f.client->start();
  ASSERT_EQ(f.transport->urls, std::vector<std::string>{"ws://test/ws"});
  EXPECT_TRUE(f.transport->sent.empty());  // 아직 연결 전

  f.transport->open();
  ASSERT_EQ(f.transport->sent.size(), 1u);
  EXPECT_EQ(f.transport->sent[0], R"({"op":"sub","symbols":["000001"]})");

  f.transport->message(snap(10, 71'200, 100));
  f.transport->message(delta(11, 71'200, 90));
  const auto view = f.client->book("000001", 10);
  EXPECT_TRUE(view.subscribed);
  EXPECT_EQ(view.sync, SyncState::Live);
  EXPECT_EQ(view.seq, 11u);
  EXPECT_EQ(view.bids, (std::vector<Level>{{71'200, 90}}));
  EXPECT_EQ(view.asks, (std::vector<Level>{{71'300, 5}}));
  EXPECT_EQ(f.states, (std::vector<ConnectionState>{ConnectionState::Connecting, ConnectionState::Open}));
}

TEST(MarketClient, GapRequestsHttpSnapshotOnceAndReplaysBuffer) {
  Fixture f;
  f.client->subscribe({"000001"});
  f.client->start();
  f.transport->open();
  f.transport->message(snap(10, 71'200, 100));

  f.transport->message(delta(12, 71'200, 80));  // 11 누락
  f.transport->message(delta(13, 71'200, 70));
  ASSERT_EQ(f.transport->snapshots().size(), 1u);  // 한 번만 요청
  EXPECT_EQ(f.transport->snapshots()[0]->url, "http://test/book/000001?depth=50");
  EXPECT_EQ(f.client->book("000001", 10).sync, SyncState::Resyncing);
  EXPECT_EQ(f.client->stats().gaps, 1u);

  // 서버 스냅샷 seq 12 → 버퍼의 13만 이어서 반영
  f.transport->snapshots()[0]->done(200, snap(12, 71'200, 80));
  const auto view = f.client->book("000001", 10);
  EXPECT_EQ(view.sync, SyncState::Live);
  EXPECT_EQ(view.seq, 13u);
  EXPECT_EQ(view.bids, (std::vector<Level>{{71'200, 70}}));
  EXPECT_EQ(f.client->stats().resyncs, 1u);
}

TEST(MarketClient, FailedSnapshotIsRetriedLater) {
  Fixture f;
  f.client->subscribe({"000001"});
  f.client->start();
  f.transport->open();
  f.transport->message(snap(10, 71'200, 100));
  f.transport->message(delta(12, 71'200, 80));
  f.transport->snapshots()[0]->done(503, "");
  ASSERT_EQ(f.transport->timers.size(), 1u);
  EXPECT_EQ(f.transport->timers[0].delay, 1'000ms);
  f.transport->runTimers();
  ASSERT_EQ(f.transport->snapshots().size(), 2u);
}

TEST(MarketClient, ReconnectsWithJitterAndResubscribes) {
  Fixture f(/*random=*/0.5);
  f.client->subscribe({"000001"});
  f.client->start();
  f.transport->open();
  f.transport->message(snap(10, 71'200, 100));

  f.transport->serverClose(1012);
  EXPECT_EQ(f.client->stats().state, ConnectionState::Reconnecting);
  EXPECT_EQ(f.client->book("000001", 10).sync, SyncState::WaitingSnapshot);  // 끊긴 동안의 호가는 버림
  ASSERT_EQ(f.transport->timers.size(), 1u);
  EXPECT_EQ(f.transport->timers[0].delay, 250ms);  // 0.5 × base(500ms)

  f.transport->runTimers();
  EXPECT_EQ(f.transport->urls.size(), 2u);
  f.transport->open();
  EXPECT_EQ(f.transport->sent.back(), R"({"op":"sub","symbols":["000001"]})");
  EXPECT_EQ(f.client->stats().attempt, 0u);
  EXPECT_EQ(f.client->stats().reconnects, 1u);
}

TEST(MarketClient, BackoffGrowsAndIsCapped) {
  Fixture f(/*random=*/0.999);
  EXPECT_LT(f.client->backoffDelay(1), 500ms);
  EXPECT_GE(f.client->backoffDelay(1), 499ms);
  EXPECT_GE(f.client->backoffDelay(3), 1'990ms);   // base·4
  EXPECT_LT(f.client->backoffDelay(20), 30'000ms);  // 상한
  EXPECT_GE(f.client->backoffDelay(20), 29'900ms);
  Fixture zero(/*random=*/0.0);
  EXPECT_EQ(zero.client->backoffDelay(5), 0ms);
}

TEST(MarketClient, ParsesRetryWindowFromCloseReason) {
  EXPECT_EQ(MarketClient::parseRetryWindow("admin disconnect; retry-window=5000"), 5000ms);
  EXPECT_EQ(MarketClient::parseRetryWindow("retry-window=500"), 500ms);
  EXPECT_EQ(MarketClient::parseRetryWindow("bye"), 0ms);
  EXPECT_EQ(MarketClient::parseRetryWindow("retry-window=abc"), 0ms);
  EXPECT_EQ(MarketClient::parseRetryWindow("retry-window=99999999999999"), 9'999'999ms);  // 7자리까지만
}

TEST(MarketClient, ServiceRestartSpreadsReconnectsOverServerWindow) {
  Fixture f(/*random=*/0.5);
  f.client->start();
  f.transport->open();
  // 서버가 5,000명을 끊으며 5초 창을 알려 줌 → 첫 재접속은 [0, 5s) (기본은 [0, 0.5s))
  f.transport->serverClose(1012, "admin disconnect; retry-window=5000");
  ASSERT_EQ(f.transport->timers.size(), 1u);
  EXPECT_EQ(f.transport->timers[0].delay, 2'500ms);
  // 다시 실패하면 지수 백오프와 창 중 큰 값
  f.transport->runTimers();
  f.transport->serverClose(1006);
  EXPECT_EQ(f.transport->timers.back().delay, 2'500ms);  // max(1s, 5s) × 0.5
  // 연결되면 창은 사라진다
  f.transport->runTimers();
  f.transport->open();
  f.transport->serverClose(1006);
  EXPECT_EQ(f.transport->timers.back().delay, 250ms);

  // 1012가 아니면 reason을 따르지 않고, 지나치게 큰 창은 backoffMax(30s)로 자른다
  Fixture g(/*random=*/0.5);
  g.client->start();
  g.transport->open();
  g.transport->serverClose(1001, "retry-window=5000");
  EXPECT_EQ(g.transport->timers.back().delay, 250ms);
  g.transport->runTimers();
  g.transport->open();
  g.transport->serverClose(1012, "retry-window=600000");
  EXPECT_EQ(g.transport->timers.back().delay, 15'000ms);
}

TEST(MarketClient, IgnoresCallbacksFromOldConnection) {
  Fixture f;
  f.client->subscribe({"000001"});
  f.client->start();
  auto oldCallbacks = f.transport->cb;
  f.transport->open();
  f.transport->serverClose(1006);
  f.transport->runTimers();  // 새 연결 시작
  f.transport->open();
  f.transport->message(snap(10, 71'200, 100));

  // 이전 연결에서 늦게 도착한 메시지는 무시돼야 한다
  oldCallbacks.onMessage(delta(11, 71'200, 1));
  oldCallbacks.onClose(1006, "late");
  EXPECT_EQ(f.client->book("000001", 10).seq, 10u);
  EXPECT_EQ(f.client->stats().state, ConnectionState::Open);
}

TEST(MarketClient, StopClosesAndCancelsPendingReconnect) {
  Fixture f;
  f.client->start();
  f.transport->open();
  f.transport->serverClose(1006);
  f.client->stop();
  EXPECT_EQ(f.transport->closedWith, std::vector<int>{1000});
  f.transport->runTimers();
  EXPECT_EQ(f.transport->urls.size(), 1u);  // 재연결하지 않음
  EXPECT_EQ(f.client->stats().state, ConnectionState::Stopped);
}

TEST(MarketClient, SubscribeAndUnsubscribeWhileOpen) {
  Fixture f;
  f.client->start();
  f.transport->open();
  f.client->subscribe({"000001", "000002"});
  f.client->subscribe({"000001"});  // 중복은 보내지 않음
  f.client->unsubscribe({"000002"});
  EXPECT_EQ(f.transport->sent, (std::vector<std::string>{R"({"op":"sub","symbols":["000001","000002"]})",
                                                          R"({"op":"unsub","symbols":["000002"]})"}));
  EXPECT_FALSE(f.client->book("000002", 10).subscribed);
}

TEST(MarketClient, TradesAreKeptNewestFirstAndBounded) {
  Fixture f;
  f.client->subscribe({"000001"});
  f.client->start();
  f.transport->open();
  for (int i = 0; i < 60; ++i) {
    f.transport->message(R"({"t":"trade","sym":"000001","ts":)" + std::to_string(i) +
                         R"(,"px":71300,"qty":)" + std::to_string(i + 1) + R"(,"aggr":"B"})");
  }
  const auto trades = f.client->trades("000001", 100);
  ASSERT_EQ(trades.size(), 50u);
  EXPECT_EQ(trades.front().qty, 60);
}

TEST(MarketClient, MalformedMessagesAreCountedNotFatal) {
  Fixture f;
  f.client->subscribe({"000001"});
  f.client->start();
  f.transport->open();
  f.transport->message("not json");
  f.transport->message(R"({"t":"delta","sym":"000001","seq":"x"})");
  f.transport->message(R"({"t":"error","code":"RATE_LIMITED","message":"slow down"})");
  EXPECT_EQ(f.client->stats().parseErrors, 2u);
  EXPECT_EQ(f.client->stats().lastError, "RATE_LIMITED: slow down");
  EXPECT_EQ(f.client->stats().state, ConnectionState::Open);
}

TEST(MarketClient, AuthenticatesBeforeSubscribingOnEveryConnection) {
  Fixture f;
  f.client->subscribe({"000001"});
  f.client->setAuthToken("token-abc");  // 연결 전: 보내지 않고 기억만
  f.client->start();
  EXPECT_TRUE(f.transport->sent.empty());
  f.transport->open();
  ASSERT_EQ(f.transport->sent.size(), 2u);
  EXPECT_EQ(f.transport->sent[0], R"({"op":"auth","token":"token-abc"})");
  EXPECT_EQ(f.transport->sent[1], R"({"op":"sub","symbols":["000001"]})");

  f.transport->message(R"({"t":"authed","userId":"u-demo"})");
  EXPECT_TRUE(f.client->stats().authenticated);

  // 재연결 후에도 다시 인증
  f.transport->serverClose(1012);
  EXPECT_FALSE(f.client->stats().authenticated);
  f.transport->runTimers();
  f.transport->open();
  EXPECT_EQ(f.transport->sent[2], R"({"op":"auth","token":"token-abc"})");

  // 연결 중 토큰 교체(갱신)는 즉시 보낸다
  f.client->setAuthToken("token-new");
  EXPECT_EQ(f.transport->sent.back(), R"({"op":"auth","token":"token-new"})");
}

TEST(MarketClient, ForwardsOrderEventsToListener) {
  Fixture f;
  std::vector<std::string> events;
  f.client->setUserEventListener([&](const std::string& json) { events.push_back(json); });
  f.client->start();
  f.transport->open();
  const std::string event = R"({"t":"order","key":"k1","orderId":3,"symbol":"000001","status":"FILLED"})";
  f.transport->message(event);
  ASSERT_EQ(events.size(), 1u);
  EXPECT_EQ(events[0], event);
}

TEST(MarketClient, MarketTapSeesEveryMarketMessageOutsideTheLock) {
  Fixture f;
  std::vector<std::string> tapped;
  f.client->setMarketTapListener([&](const std::string& json) {
    tapped.push_back(json);
    // 잠금 밖에서 불리므로 여기서 다시 읽어도 교착되지 않는다
    EXPECT_TRUE(f.client->book("000001", 1).subscribed);
  });
  f.client->subscribe({"000001"});
  f.client->start();
  f.transport->open();
  f.transport->message(snap(10, 71'200, 100));
  f.transport->message(delta(11, 71'200, 90));
  f.transport->message(R"({"t":"trade","sym":"000001","ts":1,"px":71200,"qty":3,"aggr":"B"})");
  f.transport->message(R"({"t":"delta","sym":"999999","seq":1,"ts":1,"side":"B","px":1,"qty":1})");  // 구독 안 함
  f.transport->message(R"({"t":"pong","ts":1})");
  f.transport->message("not json");
  EXPECT_EQ(tapped.size(), 3u);

  f.client->setMarketTapListener({});  // 끄기
  f.transport->message(delta(12, 71'200, 80));
  EXPECT_EQ(tapped.size(), 3u);
}

TEST(MarketClient, BuildsCandlesFromHistoryAndLiveTrades) {
  Fixture f;
  f.client->subscribe({"000001"});
  f.client->start();
  f.transport->open();
  // 연결 직후 과거 봉 요청
  auto req = std::find_if(f.transport->http.begin(), f.transport->http.end(),
                          [](const auto& h) { return h.url.find("/candles/000001") != std::string::npos; });
  ASSERT_NE(req, f.transport->http.end());
  EXPECT_EQ(req->url, "http://test/candles/000001?limit=600");
  req->done(200, R"({"interval":60000,"bars":[[0,100,110,90,105,7],[60000,105,106,104,106,3]]})");

  const auto v1 = f.client->candleVersion("000001");
  // 실시간 체결이 마지막 봉을 갱신
  f.transport->message(R"({"t":"trade","sym":"000001","ts":61000,"px":120,"qty":2,"aggr":"B"})");
  EXPECT_GT(f.client->candleVersion("000001"), v1);
  const auto bars = f.client->candles("000001", 0, 10);
  ASSERT_EQ(bars.size(), 2u);
  EXPECT_EQ(bars[1].high, 120);
  EXPECT_EQ(bars[1].close, 120);
  EXPECT_EQ(bars[1].volume, 5);
  // 5분 봉은 읽을 때 묶는다
  EXPECT_EQ(f.client->candles("000001", 300000, 10).size(), 1u);
}

TEST(MarketClient, AppliesBinaryMarketDataLikeJson) {
  using namespace hoga::wire;
  Fixture f;
  f.client->subscribe({"000001"});
  f.client->start();
  f.transport->open();
  f.transport->message(encode(SnapshotMsg{"000001", 10, 0, {{71'200, 100}}, {{71'300, 5}}}));
  f.transport->message(encode(DeltaMsg{"000001", 11, 0, hoga::Side::Bid, 71'200, 90}));
  std::vector<std::string> tapped;
  f.client->setMarketTapListener([&](const std::string& json) { tapped.push_back(json); });
  f.transport->message(encode(TradeMsg{"000001", 1'000, 71'300, 3, hoga::Side::Bid}));
  ASSERT_EQ(tapped.size(), 1u);
  EXPECT_EQ(tapped[0], R"({"t":"trade","sym":"000001","ts":1000,"px":71300,"qty":3,"aggr":"B"})");
  f.client->setMarketTapListener({});
  const auto view = f.client->book("000001", 10);
  EXPECT_EQ(view.sync, SyncState::Live);
  EXPECT_EQ(view.seq, 11u);
  EXPECT_EQ(view.bids, (std::vector<Level>{{71'200, 90}}));
  ASSERT_EQ(f.client->trades("000001", 5).size(), 1u);
  EXPECT_EQ(f.client->trades("000001", 5)[0].price, 71'300);
  // 누락 감지도 같은 규칙
  f.transport->message(encode(DeltaMsg{"000001", 13, 0, hoga::Side::Bid, 71'100, 1}));
  EXPECT_EQ(f.client->stats().gaps, 1u);
  // 깨진 이진 메시지는 세고 버린다(연결 유지)
  f.transport->message(std::string("\x02" "0000", 5));
  EXPECT_EQ(f.client->stats().parseErrors, 1u);
  EXPECT_EQ(f.client->stats().state, ConnectionState::Open);
}
