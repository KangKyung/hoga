#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "hoga/candles.hpp"
#include "hoga/market_client.hpp"

namespace hoga::chartsource {

/**
 * 네이티브 차트 뷰(Fabric)가 C++ MarketClient의 봉을 **JS를 거치지 않고** 직접 읽는 통로.
 *
 * TurboModule이 connect할 때 클라이언트를 등록하고, 차트 뷰는 화면 주사율마다 version()을 보고
 * 바뀌었을 때만 candles()로 복사본을 받아 그린다. 클라이언트는 weak_ptr로만 잡는다.
 */
void setClient(const std::shared_ptr<MarketClient>& client);

// 봉 내용 또는 연결(클라이언트)이 바뀌면 달라지는 값
std::uint64_t version(const std::string& symbol);

std::vector<Candle> candles(const std::string& symbol, std::int64_t bucketMs, std::size_t limit);

}  // namespace hoga::chartsource
