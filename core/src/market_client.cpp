#include "hoga/market_client.hpp"

#include <algorithm>
#include <random>
#include <type_traits>
#include <variant>

#include "hoga/wire.hpp"
#include "nlohmann/json.hpp"

namespace hoga {

using json = nlohmann::json;

namespace {

constexpr int kCloseNormal = 1000;

std::int64_t systemNowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

double defaultRandom() {
  thread_local std::mt19937_64 engine{std::random_device{}()};
  return std::uniform_real_distribution<double>(0.0, 1.0)(engine);
}

// [[price, qty], ...] → Level 배열. 형식이 틀린 항목은 건너뛴다.
std::vector<Level> parseLevels(const json& arr) {
  std::vector<Level> out;
  if (!arr.is_array()) return out;
  out.reserve(arr.size());
  for (const auto& item : arr) {
    if (item.is_array() && item.size() == 2 && item[0].is_number_integer() && item[1].is_number_integer()) {
      out.push_back({item[0].get<Price>(), item[1].get<Qty>()});
    }
  }
  return out;
}

std::string escapeSymbol(const std::string& symbol) {
  // 종목 코드는 숫자 6자리만 허용(서버 프로토콜과 같음). 그 외 문자는 URL에 넣지 않는다.
  std::string out;
  for (char c : symbol) {
    if (c >= '0' && c <= '9') out.push_back(c);
  }
  return out;
}

}  // namespace

std::string_view toString(ConnectionState state) noexcept {
  switch (state) {
    case ConnectionState::Idle: return "idle";
    case ConnectionState::Connecting: return "connecting";
    case ConnectionState::Open: return "open";
    case ConnectionState::Reconnecting: return "reconnecting";
    case ConnectionState::Stopped: return "stopped";
  }
  return "unknown";
}

std::string_view toString(SyncState state) noexcept {
  switch (state) {
    case SyncState::WaitingSnapshot: return "waiting";
    case SyncState::Live: return "live";
    case SyncState::Resyncing: return "resyncing";
  }
  return "unknown";
}

std::shared_ptr<MarketClient> MarketClient::create(std::shared_ptr<ITransport> transport,
                                                   MarketClientOptions options, StateListener listener) {
  return std::shared_ptr<MarketClient>(
      new MarketClient(std::move(transport), std::move(options), std::move(listener)));
}

MarketClient::MarketClient(std::shared_ptr<ITransport> transport, MarketClientOptions options,
                           StateListener listener)
    : transport_(std::move(transport)), options_(std::move(options)), listener_(std::move(listener)) {
  if (!options_.random) options_.random = defaultRandom;
  if (!options_.nowMs) options_.nowMs = systemNowMs;
}

void MarketClient::run(Deferred& after) {
  for (auto& fn : after) fn();
  after.clear();
}

std::chrono::milliseconds MarketClient::backoffDelay(std::uint32_t attempt) const {
  // full jitter: 0 ~ min(max, base·2^(attempt-1)) 사이 무작위. 재접속이 한꺼번에 몰리지 않는다.
  // milliseconds::rep는 플랫폼마다 다르다(Android: long long, int64_t: long) → rep로 통일.
  using Rep = std::chrono::milliseconds::rep;
  const Rep base = options_.backoffBase.count();
  const Rep max = options_.backoffMax.count();
  Rep cap = base;
  for (std::uint32_t i = 1; i < attempt && cap < max; ++i) cap *= 2;
  // 서버가 정한 재접속 창보다 좁게 몰리지 않는다(수천 명이 동시에 끊긴 경우)
  cap = std::min(std::max(cap, static_cast<Rep>(retryWindow_.count())), max);
  const double r = std::clamp(options_.random(), 0.0, 1.0);
  return std::chrono::milliseconds(static_cast<Rep>(r * static_cast<double>(cap)));
}

void MarketClient::setStateLocked(ConnectionState state, Deferred& after) {
  if (state_ == state && state != ConnectionState::Reconnecting) return;
  state_ = state;
  stats_.state = state;
  if (listener_) {
    after.push_back([listener = listener_, state, attempt = stats_.attempt] { listener(state, attempt); });
  }
}

void MarketClient::start() {
  Deferred after;
  {
    std::lock_guard lock(mutex_);
    if (state_ != ConnectionState::Idle && state_ != ConnectionState::Stopped) return;
    stats_.attempt = 0;
    setStateLocked(ConnectionState::Connecting, after);
    connectLocked(after);
  }
  run(after);
}

void MarketClient::stop() {
  Deferred after;
  {
    std::lock_guard lock(mutex_);
    if (state_ == ConnectionState::Stopped || state_ == ConnectionState::Idle) return;
    ++generation_;  // 이후 도착하는 콜백·타이머 모두 무시
    for (auto& [_, data] : symbols_) {
      data.sync->reset();
      data.snapshotInFlight = false;
    }
    setStateLocked(ConnectionState::Stopped, after);
    transport_->close(kCloseNormal, "client stop");
  }
  run(after);
}

void MarketClient::connectLocked(Deferred& /*after*/) {
  const auto gen = ++generation_;
  std::weak_ptr<MarketClient> weak = weak_from_this();
  TransportCallbacks callbacks;
  callbacks.onOpen = [weak, gen] {
    if (auto self = weak.lock()) self->onOpen(gen);
  };
  callbacks.onMessage = [weak, gen](std::string text) {
    if (auto self = weak.lock()) self->onMessage(gen, text);
  };
  callbacks.onClose = [weak, gen](int code, std::string reason) {
    if (auto self = weak.lock()) self->onClose(gen, code, reason);
  };
  transport_->connect(options_.wsUrl, std::move(callbacks));
}

MarketClient::SymbolData& MarketClient::ensureSymbolLocked(const std::string& symbol) {
  auto [it, inserted] = symbols_.try_emplace(symbol);
  if (inserted) {
    it->second.candles = std::make_unique<CandleSeries>(options_.candleIntervalMs, options_.candleHistory);
  }
  return it->second;
}

void MarketClient::requestCandlesLocked(const std::string& symbol) {
  auto it = symbols_.find(symbol);
  if (it == symbols_.end() || it->second.candlesInFlight) return;
  it->second.candlesInFlight = true;
  const auto url = options_.httpBaseUrl + "/candles/" + escapeSymbol(symbol) +
                   "?limit=" + std::to_string(options_.candleHistory);
  std::weak_ptr<MarketClient> weak = weak_from_this();
  transport_->httpGet(url, [weak, symbol](int status, std::string body) {
    if (auto self = weak.lock()) self->onCandlesResponse(symbol, status, body);
  });
}

void MarketClient::onCandlesResponse(const std::string& symbol, int status, const std::string& body) {
  std::lock_guard lock(mutex_);
  auto it = symbols_.find(symbol);
  if (it == symbols_.end()) return;
  it->second.candlesInFlight = false;
  if (status != 200) return;  // 과거 봉이 없어도 실시간 봉은 계속 쌓인다
  const auto msg = json::parse(body, nullptr, false);
  if (msg.is_discarded() || !msg.is_object() || !msg.contains("bars") || !msg["bars"].is_array()) {
    ++stats_.parseErrors;
    return;
  }
  std::vector<Candle> history;
  for (const auto& b : msg["bars"]) {
    if (!b.is_array() || b.size() != 6) continue;
    bool ok = true;
    for (const auto& v : b) ok = ok && v.is_number_integer();
    if (!ok) continue;
    history.push_back({b[0].get<std::int64_t>(), b[1].get<Price>(), b[2].get<Price>(), b[3].get<Price>(),
                       b[4].get<Price>(), b[5].get<Qty>()});
  }
  it->second.candles->mergeHistory(history);
}

void MarketClient::sendOpLocked(const char* op, const std::vector<std::string>& symbols) {
  if (symbols.empty() || state_ != ConnectionState::Open) return;
  json msg{{"op", op}, {"symbols", symbols}};
  transport_->send(msg.dump());
}

void MarketClient::sendAuthLocked() {
  if (authToken_.empty() || state_ != ConnectionState::Open) return;
  json msg{{"op", "auth"}, {"token", authToken_}};
  transport_->send(msg.dump());
}

void MarketClient::setAuthToken(std::string token) {
  std::lock_guard lock(mutex_);
  const bool hadToken = !authToken_.empty();
  authToken_ = std::move(token);
  stats_.authenticated = false;
  if (authToken_.empty()) {
    // 로그아웃: 연결(시세 구독)은 그대로 두고 서버에 사용자 인증만 풀어 달라고 한다.
    // 빈 토큰을 그냥 두면 서버는 이 연결을 이전 사용자로 계속 알고 주문 알림을 보낸다.
    if (hadToken && state_ == ConnectionState::Open) transport_->send(R"({"op":"unauth"})");
    return;
  }
  sendAuthLocked();
}

void MarketClient::setUserEventListener(UserEventListener listener) {
  std::lock_guard lock(mutex_);
  userListener_ = std::move(listener);
}

void MarketClient::setMarketTapListener(MarketTapListener listener) {
  std::lock_guard lock(mutex_);
  tapListener_ = std::move(listener);
}

void MarketClient::onOpen(std::uint64_t generation) {
  Deferred after;
  {
    std::lock_guard lock(mutex_);
    if (generation != generation_) return;
    stats_.attempt = 0;
    retryWindow_ = std::chrono::milliseconds{0};
    stats_.authenticated = false;
    setStateLocked(ConnectionState::Open, after);
    // 인증을 구독보다 먼저: 끊긴 동안 생긴 내 주문 변화는 앱이 REST로 다시 조회한다.
    sendAuthLocked();
    // 끊겨 있던 동안의 상태는 믿을 수 없으므로 처음부터: 서버가 구독 직후 스냅샷을 보낸다.
    std::vector<std::string> all;
    for (auto& [symbol, data] : symbols_) {
      data.sync->reset();
      data.snapshotInFlight = false;
      data.candlesInFlight = false;
      all.push_back(symbol);
    }
    sendOpLocked("sub", all);
    // 끊긴 동안 놓친 체결은 봉으로 다시 받는다
    for (const auto& symbol : all) requestCandlesLocked(symbol);
  }
  run(after);
}

std::chrono::milliseconds MarketClient::parseRetryWindow(std::string_view reason) {
  constexpr std::string_view key = "retry-window=";
  const auto at = reason.find(key);
  if (at == std::string_view::npos) return std::chrono::milliseconds{0};
  std::int64_t ms = 0;
  std::size_t digits = 0;
  for (auto i = at + key.size(); i < reason.size() && reason[i] >= '0' && reason[i] <= '9' && digits < 7; ++i, ++digits) {
    ms = ms * 10 + (reason[i] - '0');
  }
  return std::chrono::milliseconds{digits ? ms : 0};
}

void MarketClient::onClose(std::uint64_t generation, int code, const std::string& reason) {
  Deferred after;
  {
    std::lock_guard lock(mutex_);
    if (generation != generation_ || state_ == ConnectionState::Stopped) return;
    ++generation_;
    stats_.authenticated = false;  // 인증은 연결 단위
    stats_.lastError = "closed " + std::to_string(code) + (reason.empty() ? "" : " " + reason);
    for (auto& [_, data] : symbols_) {
      data.sync->reset();
      data.snapshotInFlight = false;
    }
    ++stats_.attempt;
    ++stats_.reconnects;
    // 1012(서비스 재시작)일 때만 서버의 재접속 창을 따른다. 상한은 backoffMax
    if (code == 1012) retryWindow_ = std::min(parseRetryWindow(reason), options_.backoffMax);
    setStateLocked(ConnectionState::Reconnecting, after);

    const auto delay = backoffDelay(stats_.attempt);
    const auto gen = generation_;
    std::weak_ptr<MarketClient> weak = weak_from_this();
    transport_->schedule(delay, [weak, gen] {
      auto self = weak.lock();
      if (!self) return;
      Deferred later;
      {
        std::lock_guard lock(self->mutex_);
        if (gen != self->generation_ || self->state_ != ConnectionState::Reconnecting) return;
        self->connectLocked(later);
      }
      run(later);
    });
  }
  run(after);
}

void MarketClient::onMessage(std::uint64_t generation, const std::string& text) {
  Deferred after;
  {
    std::lock_guard lock(mutex_);
    if (generation != generation_) return;
    ++stats_.messages;
    handleMessageLocked(text, after);
  }
  run(after);
}

void MarketClient::handleMessageLocked(const std::string& text, Deferred& after) {
  if (wire::isBinary(text)) {
    handleBinaryLocked(text, after);
    return;
  }
  const auto msg = json::parse(text, nullptr, /*allow_exceptions=*/false);
  if (msg.is_discarded() || !msg.is_object()) {
    ++stats_.parseErrors;
    return;
  }
  try {
    const auto type = msg.value("t", std::string{});
    if (type == "order") {
      // 로그아웃 직후 이미 오고 있던 알림은 버린다(서버가 unauth를 처리하기 전 메시지)
      if (authToken_.empty()) return;
      if (userListener_) after.push_back([listener = userListener_, text] { listener(text); });
      return;
    }
    if (type == "authed") {
      stats_.authenticated = true;
      return;
    }
    if (type == "unauthed") {
      stats_.authenticated = false;
      return;
    }
    if (type == "error") {
      stats_.lastError = msg.value("code", std::string{}) + ": " + msg.value("message", std::string{});
      return;
    }
    const auto symbol = msg.value("sym", std::string{});
    if (type == "status") {
      // 매매 상태는 시세 순서(seq)와 무관하다. 구독 중인 종목만 덮어쓴다(빈도가 낮아 JS로 밀지 않고 book()에 싣는다)
      auto it = symbols_.find(symbol);
      if (it == symbols_.end()) return;
      SessionView view;
      view.phase = msg.value("phase", std::string{});
      view.mode = msg.value("mode", std::string{});
      if (const auto vi = msg.find("vi"); vi != msg.end() && vi->is_object()) {
        view.viKind = vi->value("kind", std::string{});
        view.viUntil = vi->value("until", std::int64_t{0});
        view.viRef = vi->value("ref", Price{0});
      }
      if (const auto exp = msg.find("exp"); exp != msg.end() && exp->is_object()) {
        view.expPrice = exp->value("px", Price{0});
        view.expQty = exp->value("qty", Qty{0});
      }
      it->second.session = std::move(view);
      it->second.lastUpdateMs = options_.nowMs();
      return;
    }
    if (type == "snap") {
      const auto bids = parseLevels(msg.at("bids"));
      const auto asks = parseLevels(msg.at("asks"));
      if (!applySnapshotLocked(symbol, msg.at("seq").get<Seq>(), bids, asks)) return;
    } else if (type == "delta") {
      const Delta delta{msg.at("seq").get<Seq>(), msg.at("side").get<std::string>() == "B" ? Side::Bid : Side::Ask,
                        msg.at("px").get<Price>(), msg.at("qty").get<Qty>()};
      if (!applyDeltaLocked(symbol, delta)) return;
    } else if (type == "trade") {
      const Trade trade{msg.at("px").get<Price>(), msg.at("qty").get<Qty>(),
                        msg.at("aggr").get<std::string>() == "B" ? Side::Bid : Side::Ask, msg.value("ts", std::int64_t{0})};
      if (!applyTradeLocked(symbol, trade)) return;
    } else {
      return;
    }
    // 잠금 밖에서 부른다(받는 쪽이 book() 등을 다시 불러도 교착되지 않게)
    if (tapListener_) after.push_back([listener = tapListener_, text] { listener(text); });
  } catch (const json::exception&) {
    // 필드가 없거나 타입이 틀린 메시지. 연결은 유지하고 버린다.
    ++stats_.parseErrors;
  }
}

// 이진 시세(v1). 주문 알림·오류 같은 드문 메시지는 계속 JSON이다.
void MarketClient::handleBinaryLocked(const std::string& bytes, Deferred& after) {
  const auto decoded = wire::decode(bytes);
  if (!decoded) {
    ++stats_.parseErrors;
    return;
  }
  const bool known = std::visit(
      [this](const auto& m) {
        using T = std::decay_t<decltype(m)>;
        if constexpr (std::is_same_v<T, wire::SnapshotMsg>) {
          return applySnapshotLocked(m.symbol, m.seq, m.bids, m.asks);
        } else if constexpr (std::is_same_v<T, wire::DeltaMsg>) {
          return applyDeltaLocked(m.symbol, Delta{m.seq, m.side, m.price, m.qty});
        } else {
          return applyTradeLocked(m.symbol, Trade{m.price, m.qty, m.aggressor, m.ts});
        }
      },
      *decoded);
  // 비교 실험 탭은 JSON 문자열을 기대한다(JS에 이진 바이트를 문자열로 넘길 수 없다)
  if (known && tapListener_) after.push_back([listener = tapListener_, json = wire::toJson(*decoded)] { listener(json); });
}

bool MarketClient::applySnapshotLocked(const std::string& symbol, Seq seq, std::span<const Level> bids,
                                       std::span<const Level> asks) {
  auto it = symbols_.find(symbol);
  if (it == symbols_.end()) return false;  // 구독 해제한 종목의 늦은 메시지
  auto& data = it->second;
  const auto event = data.sync->onSnapshot(seq, bids, asks);
  data.lastUpdateMs = options_.nowMs();
  if (event == SyncEvent::NeedSnapshot) requestSnapshotLocked(symbol);
  return true;
}

bool MarketClient::applyDeltaLocked(const std::string& symbol, const Delta& delta) {
  auto it = symbols_.find(symbol);
  if (it == symbols_.end()) return false;
  auto& data = it->second;
  const auto event = data.sync->onDelta(delta);
  if (event == SyncEvent::Applied) data.lastUpdateMs = options_.nowMs();
  if (event == SyncEvent::NeedSnapshot) {
    ++stats_.gaps;
    requestSnapshotLocked(symbol);
  }
  return true;
}

bool MarketClient::applyTradeLocked(const std::string& symbol, const Trade& trade) {
  auto it = symbols_.find(symbol);
  if (it == symbols_.end()) return false;
  auto& data = it->second;
  data.trades.push_front(trade);
  while (data.trades.size() > options_.tradeHistory) data.trades.pop_back();
  data.candles->addTrade(trade.ts, trade.price, trade.qty);
  return true;
}

void MarketClient::requestSnapshotLocked(const std::string& symbol) {
  auto it = symbols_.find(symbol);
  if (it == symbols_.end() || it->second.snapshotInFlight) return;
  it->second.snapshotInFlight = true;

  const auto depth = options_.snapshotDepth == 0 ? std::string{"all"} : std::to_string(options_.snapshotDepth);
  const auto url = options_.httpBaseUrl + "/book/" + escapeSymbol(symbol) + "?depth=" + depth;
  std::weak_ptr<MarketClient> weak = weak_from_this();
  // 요청한 연결 세대를 함께 기억한다: 재연결 뒤 늦게 온 이전 서버의 스냅샷(seq 체계가 다를 수 있다)을 버리기 위해
  transport_->httpGet(url, [weak, symbol, generation = generation_](int status, std::string body) {
    if (auto self = weak.lock()) self->onSnapshotResponse(symbol, generation, status, body);
  });
}

void MarketClient::onSnapshotResponse(const std::string& symbol, std::uint64_t generation, int status,
                                      const std::string& body) {
  std::lock_guard lock(mutex_);
  // 재연결로 세대가 바뀌었으면 무시한다. onOpen이 snapshotInFlight를 이미 풀고 장부를 초기화했다
  if (generation != generation_) return;
  auto it = symbols_.find(symbol);
  if (it == symbols_.end()) return;
  auto& data = it->second;
  data.snapshotInFlight = false;
  if (state_ == ConnectionState::Stopped) return;

  const auto msg = status == 200 ? json::parse(body, nullptr, false) : json();
  if (status != 200 || msg.is_discarded() || !msg.is_object()) {
    stats_.lastError = "snapshot " + symbol + " failed: HTTP " + std::to_string(status);
    // 잠시 후 다시 시도(여전히 재동기화가 필요할 때만)
    std::weak_ptr<MarketClient> weak = weak_from_this();
    transport_->schedule(options_.snapshotRetry, [weak, symbol] {
      auto self = weak.lock();
      if (!self) return;
      std::lock_guard lock(self->mutex_);
      auto found = self->symbols_.find(symbol);
      if (found != self->symbols_.end() && found->second.sync->state() == SyncState::Resyncing) {
        self->requestSnapshotLocked(symbol);
      }
    });
    return;
  }

  try {
    const auto event = data.sync->onSnapshot(msg.at("seq").get<Seq>(), parseLevels(msg.at("bids")),
                                             parseLevels(msg.at("asks")));
    if (event == SyncEvent::Synced) {
      ++stats_.resyncs;
      data.lastUpdateMs = options_.nowMs();
    } else if (event == SyncEvent::NeedSnapshot) {
      requestSnapshotLocked(symbol);
    }
  } catch (const json::exception&) {
    ++stats_.parseErrors;
  }
}

void MarketClient::subscribe(const std::vector<std::string>& symbols) {
  std::lock_guard lock(mutex_);
  std::vector<std::string> added;
  for (const auto& symbol : symbols) {
    if (symbols_.find(symbol) == symbols_.end()) {
      ensureSymbolLocked(symbol);
      added.push_back(symbol);
    }
  }
  sendOpLocked("sub", added);
  if (state_ == ConnectionState::Open) {
    for (const auto& symbol : added) requestCandlesLocked(symbol);
  }
}

void MarketClient::unsubscribe(const std::vector<std::string>& symbols) {
  std::lock_guard lock(mutex_);
  std::vector<std::string> removed;
  for (const auto& symbol : symbols) {
    if (symbols_.erase(symbol) > 0) removed.push_back(symbol);
  }
  sendOpLocked("unsub", removed);
}

BookView MarketClient::book(const std::string& symbol, std::size_t depth) const {
  std::lock_guard lock(mutex_);
  BookView view;
  auto it = symbols_.find(symbol);
  if (it == symbols_.end()) return view;
  const auto& data = it->second;
  const auto& book = data.sync->book();
  view.subscribed = true;
  view.sync = data.sync->state();
  view.seq = book.seq();
  view.bids = book.top(Side::Bid, depth);
  view.asks = book.top(Side::Ask, depth);
  view.lastUpdateMs = data.lastUpdateMs;
  view.session = data.session;
  return view;
}

std::vector<Trade> MarketClient::trades(const std::string& symbol, std::size_t limit) const {
  std::lock_guard lock(mutex_);
  auto it = symbols_.find(symbol);
  if (it == symbols_.end()) return {};
  const auto& list = it->second.trades;
  return {list.begin(), list.begin() + static_cast<std::ptrdiff_t>(std::min(limit, list.size()))};
}

std::vector<Candle> MarketClient::candles(const std::string& symbol, std::int64_t bucketMs, std::size_t limit) const {
  std::lock_guard lock(mutex_);
  auto it = symbols_.find(symbol);
  if (it == symbols_.end()) return {};
  return it->second.candles->bars(limit, bucketMs);
}

std::uint64_t MarketClient::candleVersion(const std::string& symbol) const {
  std::lock_guard lock(mutex_);
  auto it = symbols_.find(symbol);
  return it == symbols_.end() ? 0 : it->second.candles->version();
}

ClientStats MarketClient::stats() const {
  std::lock_guard lock(mutex_);
  return stats_;
}

}  // namespace hoga
