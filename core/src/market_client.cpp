#include "hoga/market_client.hpp"

#include <algorithm>
#include <random>

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
  cap = std::min(cap, max);
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

void MarketClient::sendOpLocked(const char* op, const std::vector<std::string>& symbols) {
  if (symbols.empty() || state_ != ConnectionState::Open) return;
  json msg{{"op", op}, {"symbols", symbols}};
  transport_->send(msg.dump());
}

void MarketClient::onOpen(std::uint64_t generation) {
  Deferred after;
  {
    std::lock_guard lock(mutex_);
    if (generation != generation_) return;
    stats_.attempt = 0;
    setStateLocked(ConnectionState::Open, after);
    // 끊겨 있던 동안의 상태는 믿을 수 없으므로 처음부터: 서버가 구독 직후 스냅샷을 보낸다.
    std::vector<std::string> all;
    for (auto& [symbol, data] : symbols_) {
      data.sync->reset();
      data.snapshotInFlight = false;
      all.push_back(symbol);
    }
    sendOpLocked("sub", all);
  }
  run(after);
}

void MarketClient::onClose(std::uint64_t generation, int code, const std::string& reason) {
  Deferred after;
  {
    std::lock_guard lock(mutex_);
    if (generation != generation_ || state_ == ConnectionState::Stopped) return;
    ++generation_;
    stats_.lastError = "closed " + std::to_string(code) + (reason.empty() ? "" : " " + reason);
    for (auto& [_, data] : symbols_) {
      data.sync->reset();
      data.snapshotInFlight = false;
    }
    ++stats_.attempt;
    ++stats_.reconnects;
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
  std::lock_guard lock(mutex_);
  if (generation != generation_) return;
  ++stats_.messages;
  handleMessageLocked(text);
}

void MarketClient::handleMessageLocked(const std::string& text) {
  const auto msg = json::parse(text, nullptr, /*allow_exceptions=*/false);
  if (msg.is_discarded() || !msg.is_object()) {
    ++stats_.parseErrors;
    return;
  }
  try {
    const auto type = msg.value("t", std::string{});
    if (type == "error") {
      stats_.lastError = msg.value("code", std::string{}) + ": " + msg.value("message", std::string{});
      return;
    }
    const auto symbol = msg.value("sym", std::string{});
    auto it = symbols_.find(symbol);
    if (it == symbols_.end()) return;  // 구독 해제한 종목의 늦은 메시지
    auto& data = it->second;
    const auto now = options_.nowMs();

    if (type == "snap") {
      const auto bids = parseLevels(msg.at("bids"));
      const auto asks = parseLevels(msg.at("asks"));
      const auto event = data.sync->onSnapshot(msg.at("seq").get<Seq>(), bids, asks);
      data.lastUpdateMs = now;
      if (event == SyncEvent::NeedSnapshot) requestSnapshotLocked(symbol);
    } else if (type == "delta") {
      const Delta delta{msg.at("seq").get<Seq>(), msg.at("side").get<std::string>() == "B" ? Side::Bid : Side::Ask,
                        msg.at("px").get<Price>(), msg.at("qty").get<Qty>()};
      const auto event = data.sync->onDelta(delta);
      if (event == SyncEvent::Applied) data.lastUpdateMs = now;
      if (event == SyncEvent::NeedSnapshot) {
        ++stats_.gaps;
        requestSnapshotLocked(symbol);
      }
    } else if (type == "trade") {
      data.trades.push_front({msg.at("px").get<Price>(), msg.at("qty").get<Qty>(),
                              msg.at("aggr").get<std::string>() == "B" ? Side::Bid : Side::Ask,
                              msg.value("ts", std::int64_t{0})});
      while (data.trades.size() > options_.tradeHistory) data.trades.pop_back();
    }
  } catch (const json::exception&) {
    // 필드가 없거나 타입이 틀린 메시지. 연결은 유지하고 버린다.
    ++stats_.parseErrors;
  }
}

void MarketClient::requestSnapshotLocked(const std::string& symbol) {
  auto it = symbols_.find(symbol);
  if (it == symbols_.end() || it->second.snapshotInFlight) return;
  it->second.snapshotInFlight = true;

  const auto url = options_.httpBaseUrl + "/book/" + escapeSymbol(symbol) +
                   "?depth=" + std::to_string(options_.snapshotDepth);
  std::weak_ptr<MarketClient> weak = weak_from_this();
  transport_->httpGet(url, [weak, symbol](int status, std::string body) {
    if (auto self = weak.lock()) self->onSnapshotResponse(symbol, status, body);
  });
}

void MarketClient::onSnapshotResponse(const std::string& symbol, int status, const std::string& body) {
  std::lock_guard lock(mutex_);
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
    if (symbols_.try_emplace(symbol).second) added.push_back(symbol);
  }
  sendOpLocked("sub", added);
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
  return view;
}

std::vector<Trade> MarketClient::trades(const std::string& symbol, std::size_t limit) const {
  std::lock_guard lock(mutex_);
  auto it = symbols_.find(symbol);
  if (it == symbols_.end()) return {};
  const auto& list = it->second.trades;
  return {list.begin(), list.begin() + static_cast<std::ptrdiff_t>(std::min(limit, list.size()))};
}

ClientStats MarketClient::stats() const {
  std::lock_guard lock(mutex_);
  return stats_;
}

}  // namespace hoga
