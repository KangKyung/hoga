#pragma once

#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "hoga/book_sync.hpp"
#include "hoga/candles.hpp"
#include "hoga/transport.hpp"

namespace hoga {

enum class ConnectionState : std::uint8_t {
  Idle,          // start() 전
  Connecting,    // 첫 연결 시도 중
  Open,          // 연결됨
  Reconnecting,  // 끊겨서 백오프 후 재연결 대기·시도 중
  Stopped,       // stop() 후
};

std::string_view toString(ConnectionState state) noexcept;
std::string_view toString(SyncState state) noexcept;

struct Trade {
  Price price{0};
  Qty qty{0};
  Side aggressor{Side::Bid};
  std::int64_t ts{0};
  bool auction{false};  // 단일가 체결(주도한 쪽 없음)
};

// 서버 status 메시지(장 구간·매매 방식·VI·단일가 예상 체결). 받기 전에는 phase가 비어 있다.
struct SessionView {
  std::string phase;   // PRE_OPEN | OPEN | CLOSING | CLOSED
  std::string mode;    // CONTINUOUS | AUCTION | HALTED
  std::string viKind;  // 비어 있으면 VI 아님, STATIC | DYNAMIC
  std::int64_t viUntil{0};
  Price viRef{0};
  Price expPrice{0};  // 단일가 예상 체결가(0이면 없음)
  Qty expQty{0};
};

// JS·UI가 읽어 가는 한 종목의 화면용 사본.
struct BookView {
  bool subscribed{false};
  Seq seq{0};
  SyncState sync{SyncState::WaitingSnapshot};
  std::vector<Level> bids;
  std::vector<Level> asks;
  std::int64_t lastUpdateMs{0};  // 마지막으로 호가가 바뀐 시각(epoch ms)
  SessionView session;
};

struct ClientStats {
  ConnectionState state{ConnectionState::Idle};
  std::uint32_t attempt{0};       // 연속 재연결 시도 횟수(연결되면 0)
  std::uint64_t messages{0};
  std::uint64_t gaps{0};          // seq 누락 감지 횟수
  std::uint64_t resyncs{0};       // 스냅샷으로 다시 맞춘 횟수
  std::uint64_t reconnects{0};
  std::uint64_t parseErrors{0};
  bool authenticated{false};      // 현재 연결에서 사용자 인증 완료
  std::string lastError;
};

struct MarketClientOptions {
  std::string wsUrl;        // ws://host:port/ws
  std::string httpBaseUrl;  // http://host:port (스냅샷 요청용)
  std::chrono::milliseconds backoffBase{500};
  std::chrono::milliseconds backoffMax{30'000};
  std::chrono::milliseconds snapshotRetry{1'000};
  std::size_t tradeHistory{50};
  /** HTTP 재동기화 스냅샷 깊이. 0 = 전체(기본). 변경분은 전체 깊이로 오므로 일부만 받으면 호가가 빠진다 */
  std::size_t snapshotDepth{0};
  std::int64_t candleIntervalMs{60'000};  // 기본 봉 구간(1분). 더 긴 구간은 읽을 때 묶는다
  std::size_t candleHistory{600};
  std::function<double()> random;         // [0, 1). 기본: 표준 난수
  std::function<std::int64_t()> nowMs;    // 기본: system_clock
};

/**
 * 시세 클라이언트(플랫폼 공용).
 *
 * - 연결·재연결: 끊기면 full jitter 지수 백오프로 흩어져 재접속(서버 재시작 때 일제히 몰리지 않게).
 * - 구독: 연결될 때마다 원하는 종목을 다시 구독, 서버가 스냅샷을 먼저 보낸다.
 * - 재동기화: 종목별 BookSync가 seq 누락을 감지하면 HTTP로 스냅샷을 받아 이어 붙인다.
 * - 스레드: 소켓·HTTP·타이머 콜백(아무 스레드)은 내부 뮤텍스로 직렬화한다.
 *   book()/trades()/stats()는 JS·UI 스레드에서 언제든 불러도 된다(복사본을 돌려준다).
 * - 수명: 콜백은 weak_ptr로 자신을 잡아서, 클라이언트가 사라진 뒤 도착한 콜백은 무시된다.
 *   연결마다 세대(generation) 번호를 붙여 이전 연결에서 늦게 온 콜백도 무시한다.
 */
class MarketClient : public std::enable_shared_from_this<MarketClient> {
 public:
  using StateListener = std::function<void(ConnectionState state, std::uint32_t attempt)>;
  // 내 주문 알림(JSON 원문). 빈도가 낮아 JS로 바로 밀어 준다(시세와 달리 push).
  using UserEventListener = std::function<void(const std::string& json)>;
  // 비교 실험용: 받은 시세 메시지(snap·delta·trade) 원문을 그대로 넘긴다.
  // 앱 기본 경로는 이걸 쓰지 않는다("JS 경유" 버전을 일부러 만들어 C++ 직접 + pull과 비교할 때만 켠다).
  using MarketTapListener = std::function<void(const std::string& json)>;

  static std::shared_ptr<MarketClient> create(std::shared_ptr<ITransport> transport,
                                              MarketClientOptions options,
                                              StateListener listener = {});

  void start();
  void stop();

  // 로그인한 사용자의 액세스 토큰. 연결될 때마다 구독보다 먼저 인증한다. 빈 문자열이면 인증하지 않는다.
  void setAuthToken(std::string token);
  void setUserEventListener(UserEventListener listener);
  // 빈 함수를 넘기면 끈다
  void setMarketTapListener(MarketTapListener listener);

  void subscribe(const std::vector<std::string>& symbols);
  void unsubscribe(const std::vector<std::string>& symbols);

  BookView book(const std::string& symbol, std::size_t depth) const;
  std::vector<Trade> trades(const std::string& symbol, std::size_t limit) const;
  // 차트용 봉. bucketMs가 0이면 기본 구간. 화면 스레드에서 직접 불러도 된다(복사본).
  std::vector<Candle> candles(const std::string& symbol, std::int64_t bucketMs, std::size_t limit) const;
  // 봉이 바뀔 때마다 증가. 화면은 이 값이 바뀐 프레임에만 다시 그린다.
  std::uint64_t candleVersion(const std::string& symbol) const;
  ClientStats stats() const;

  // attempt번째(1부터) 재연결 전 대기 시간. [0, min(max, base·2^(attempt-1))) 범위의 무작위 값.
  // 서버가 재접속 창을 알려 줬으면(1012 close reason의 retry-window) 상한은 적어도 그 창이다.
  std::chrono::milliseconds backoffDelay(std::uint32_t attempt) const;

  // close reason에서 "retry-window=<ms>"를 읽는다. 없거나 틀리면 0
  static std::chrono::milliseconds parseRetryWindow(std::string_view reason);

 private:
  struct SymbolData {
    std::unique_ptr<BookSync> sync = std::make_unique<BookSync>();
    std::deque<Trade> trades;
    std::int64_t lastUpdateMs{0};
    bool snapshotInFlight{false};
    std::unique_ptr<CandleSeries> candles;
    bool candlesInFlight{false};
    SessionView session;
  };
  using Deferred = std::vector<std::function<void()>>;

  MarketClient(std::shared_ptr<ITransport> transport, MarketClientOptions options, StateListener listener);

  void connectLocked(Deferred& after);
  void setStateLocked(ConnectionState state, Deferred& after);
  void onOpen(std::uint64_t generation);
  void onMessage(std::uint64_t generation, const std::string& text);
  void onClose(std::uint64_t generation, int code, const std::string& reason);
  void handleMessageLocked(const std::string& text, Deferred& after);
  void handleBinaryLocked(const std::string& bytes, Deferred& after);
  // 구독 중인 종목이면 반영하고 true(JSON·이진 공용)
  bool applySnapshotLocked(const std::string& symbol, Seq seq, std::span<const Level> bids, std::span<const Level> asks);
  bool applyDeltaLocked(const std::string& symbol, const Delta& delta);
  bool applyTradeLocked(const std::string& symbol, const Trade& trade);
  void sendAuthLocked();
  void requestSnapshotLocked(const std::string& symbol);
  void onSnapshotResponse(const std::string& symbol, std::uint64_t generation, int status, const std::string& body);
  void sendOpLocked(const char* op, const std::vector<std::string>& symbols);
  void requestCandlesLocked(const std::string& symbol);
  void onCandlesResponse(const std::string& symbol, int status, const std::string& body);
  SymbolData& ensureSymbolLocked(const std::string& symbol);
  static void run(Deferred& after);

  mutable std::mutex mutex_;
  std::shared_ptr<ITransport> transport_;
  MarketClientOptions options_;
  StateListener listener_;
  UserEventListener userListener_;
  MarketTapListener tapListener_;
  std::string authToken_;

  std::map<std::string, SymbolData, std::less<>> symbols_;
  ConnectionState state_{ConnectionState::Idle};
  std::uint64_t generation_{0};
  ClientStats stats_;
  // 서버가 알려 준 재접속 창. 다시 연결되면 0으로 돌아간다
  std::chrono::milliseconds retryWindow_{0};
};

}  // namespace hoga
