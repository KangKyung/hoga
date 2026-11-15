#include "ChartDataSource.h"

#include <mutex>

namespace hoga::chartsource {

namespace {
std::mutex gMutex;
std::weak_ptr<MarketClient> gClient;
std::uint64_t gGeneration = 0;

std::shared_ptr<MarketClient> current(std::uint64_t* generation) {
  std::lock_guard lock(gMutex);
  if (generation) *generation = gGeneration;
  return gClient.lock();
}
}  // namespace

void setClient(const std::shared_ptr<MarketClient>& client) {
  std::lock_guard lock(gMutex);
  gClient = client;
  ++gGeneration;
}

std::uint64_t version(const std::string& symbol) {
  std::uint64_t generation = 0;
  const auto client = current(&generation);
  // 상위 비트에 클라이언트 세대를 섞어, 다시 연결하면 봉 버전이 같아도 다시 그리게 한다
  return (generation << 48) ^ (client ? client->candleVersion(symbol) : 0);
}

std::vector<Candle> candles(const std::string& symbol, std::int64_t bucketMs, std::size_t limit) {
  const auto client = current(nullptr);
  return client ? client->candles(symbol, bucketMs, limit) : std::vector<Candle>{};
}

}  // namespace hoga::chartsource
