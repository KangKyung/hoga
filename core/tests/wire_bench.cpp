// JSON vs 이진(wire v1) 시세 — 앱이 실제로 쓰는 MarketClient 수신 경로(파싱 + 호가 반영 + 체결 기록)의 비용 비교.
// 서버와 비슷한 메시지 흐름(종목 5개, 변경분 90% · 체결 10%)을 미리 만들어 두고 같은 순서로 넣는다.
// 실행: core/build/hoga_wire_bench [메시지 수=300000]
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <memory>
#include <random>
#include <string>
#include <vector>

#include "hoga/market_client.hpp"
#include "hoga/wire.hpp"
#include "nlohmann/json.hpp"

namespace {

class NullTransport : public hoga::ITransport {
 public:
  void connect(const std::string&, hoga::TransportCallbacks callbacks) override { cb = std::move(callbacks); }
  void send(const std::string&) override {}
  void close(int, const std::string&) override {}
  void httpGet(const std::string&, std::function<void(int, std::string)>) override {}
  void schedule(std::chrono::milliseconds, std::function<void()>) override {}
  hoga::TransportCallbacks cb;
};

struct Stream {
  std::vector<std::string> json, binary;
};

Stream makeStream(std::size_t n) {
  using namespace hoga::wire;
  std::mt19937_64 rng(42);
  const std::vector<std::pair<std::string, hoga::Price>> symbols = {
      {"000001", 71'200}, {"000002", 18'450}, {"000003", 4'215}, {"000004", 152'300}, {"000005", 1'234}};
  std::vector<hoga::Seq> seq(symbols.size(), 0);
  Stream s;
  auto add = [&s](const Message& m) {
    s.binary.push_back(encode(m));
    nlohmann::json j;
    std::visit(
        [&j](const auto& v) {
          using T = std::decay_t<decltype(v)>;
          j["sym"] = v.symbol;
          j["ts"] = v.ts;
          if constexpr (std::is_same_v<T, SnapshotMsg>) {
            j["t"] = "snap";
            j["seq"] = v.seq;
            auto lv = [](const std::vector<hoga::Level>& ls) {
              auto a = nlohmann::json::array();
              for (const auto& l : ls) a.push_back({l.price, l.qty});
              return a;
            };
            j["bids"] = lv(v.bids);
            j["asks"] = lv(v.asks);
          } else if constexpr (std::is_same_v<T, DeltaMsg>) {
            j["t"] = "delta";
            j["seq"] = v.seq;
            j["side"] = v.side == hoga::Side::Bid ? "B" : "A";
            j["px"] = v.price;
            j["qty"] = v.qty;
          } else {
            j["t"] = "trade";
            j["px"] = v.price;
            j["qty"] = v.qty;
            j["aggr"] = v.aggressor == hoga::Side::Bid ? "B" : "A";
          }
        },
        m);
    s.json.push_back(j.dump());
  };
  const std::int64_t t0 = 1'794'790'000'000;
  for (std::size_t i = 0; i < symbols.size(); ++i) {
    SnapshotMsg snap{symbols[i].first, 0, t0, {}, {}};
    for (int k = 1; k <= 10; ++k) {
      snap.bids.push_back({symbols[i].second - k * 10, 100 * k});
      snap.asks.push_back({symbols[i].second + k * 10, 100 * k});
    }
    add(snap);
  }
  for (std::size_t m = 0; m < n; ++m) {
    const auto i = rng() % symbols.size();
    const auto px = symbols[i].second + static_cast<hoga::Price>(rng() % 21) * 10 - 100;
    const auto ts = t0 + static_cast<std::int64_t>(m);
    if (rng() % 10 == 0) {
      add(TradeMsg{symbols[i].first, ts, px, static_cast<hoga::Qty>(1 + rng() % 50) * 10, rng() % 2 ? hoga::Side::Bid : hoga::Side::Ask});
    } else {
      add(DeltaMsg{symbols[i].first, ++seq[i], ts, rng() % 2 ? hoga::Side::Bid : hoga::Side::Ask, px,
                   static_cast<hoga::Qty>(rng() % 60) * 10});
    }
  }
  return s;
}

double runNsPerMsg(const std::vector<std::string>& messages) {
  auto transport = std::make_shared<NullTransport>();
  hoga::MarketClientOptions options;
  options.wsUrl = "ws://bench/ws";
  options.httpBaseUrl = "http://bench";
  auto client = hoga::MarketClient::create(transport, options);
  client->subscribe({"000001", "000002", "000003", "000004", "000005"});
  client->start();
  transport->cb.onOpen();
  const auto start = std::chrono::steady_clock::now();
  for (const auto& m : messages) transport->cb.onMessage(m);
  const auto ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - start).count();
  if (client->stats().parseErrors || client->stats().gaps) std::fprintf(stderr, "unexpected errors/gaps\n");
  client->stop();
  return ns / static_cast<double>(messages.size());
}

double median(std::vector<double> v) {
  std::sort(v.begin(), v.end());
  return v[v.size() / 2];
}

}  // namespace

int main(int argc, char** argv) {
  const std::size_t n = argc > 1 ? std::stoul(argv[1]) : 300'000;
  const auto stream = makeStream(n);
  auto avgBytes = [](const std::vector<std::string>& v) {
    std::size_t total = 0;
    for (const auto& s : v) total += s.size();
    return static_cast<double>(total) / static_cast<double>(v.size());
  };
  std::vector<double> json, binary;
  for (int round = 0; round < 7; ++round) {
    json.push_back(runNsPerMsg(stream.json));
    binary.push_back(runNsPerMsg(stream.binary));
  }
  const double j = median(json), b = median(binary);
  std::printf("{\"messages\":%zu,\"jsonBytes\":%.1f,\"binaryBytes\":%.1f,\"jsonNsPerMsg\":%.0f,\"binaryNsPerMsg\":%.0f,\"speedup\":%.2f}\n",
              stream.json.size(), avgBytes(stream.json), avgBytes(stream.binary), j, b, j / b);
  return 0;
}
