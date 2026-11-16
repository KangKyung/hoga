#pragma once

// 시세 메시지 이진 형식(v1) — "JSON vs 바이너리" 비교 실험(ADR 0010)용.
//
// 모든 메시지: [u8 종류][종목 코드 6바이트 ASCII] + 본문. 정수는 부호 없는 LEB128 가변 길이.
// (가격·수량·seq·시각은 음수가 없다. 71,200원은 3바이트, epoch ms 시각은 6바이트)
//   1 snap : seq, ts, 매수 단계 수, (가격, 잔량)×n, 매도 단계 수, (가격, 잔량)×n
//   2 delta: seq, ts, [u8 0=B 1=A], 가격, 새 잔량
//   3 trade: ts, 가격, 수량, [u8 0=B 1=A](체결을 일으킨 쪽)
// 같은 형식을 서버(TS, server/src/wire.ts)가 만들고, 두 구현은 shared/protocol/wire-v1.json의
// 고정 예시(골든 벡터)로 서로 맞는지 시험한다.

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "hoga/types.hpp"

namespace hoga::wire {

enum class Type : std::uint8_t { Snapshot = 1, Delta = 2, Trade = 3 };

struct SnapshotMsg {
  std::string symbol;
  Seq seq{0};
  std::int64_t ts{0};
  std::vector<Level> bids;
  std::vector<Level> asks;
  bool operator==(const SnapshotMsg&) const = default;
};

struct DeltaMsg {
  std::string symbol;
  Seq seq{0};
  std::int64_t ts{0};
  Side side{Side::Bid};
  Price price{0};
  Qty qty{0};
  bool operator==(const DeltaMsg&) const = default;
};

struct TradeMsg {
  std::string symbol;
  std::int64_t ts{0};
  Price price{0};
  Qty qty{0};
  Side aggressor{Side::Bid};
  // 단일가 체결: 주도한 쪽이 없다(이진 1바이트 값 2, JSON "N"). true면 aggressor는 쓰지 않는다
  bool auction{false};
  bool operator==(const TradeMsg&) const = default;
};

using Message = std::variant<SnapshotMsg, DeltaMsg, TradeMsg>;

// 이진 메시지인지(JSON은 '{'로 시작). 첫 바이트만 본다.
inline bool isBinary(std::string_view bytes) noexcept {
  return !bytes.empty() && static_cast<std::uint8_t>(bytes[0]) >= 1 && static_cast<std::uint8_t>(bytes[0]) <= 3;
}

std::string encode(const Message& message);
// 서버 JSON과 같은 모양의 문자열(비교 실험의 "JS 경유" 탭이 이진 연결에서도 JSON을 받도록)
std::string toJson(const Message& message);
// 형식이 틀리거나(잘림·음수·단계 수 과다·남는 바이트) 모르는 종류면 nullopt
std::optional<Message> decode(std::string_view bytes);

}  // namespace hoga::wire
