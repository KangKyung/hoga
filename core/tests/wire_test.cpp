#include <gtest/gtest.h>

#include <fstream>
#include <sstream>

#include "hoga/wire.hpp"
#include "nlohmann/json.hpp"

using hoga::Level;
using hoga::Side;
using namespace hoga::wire;

namespace {

std::string fromHex(const std::string& hex) {
  std::string out;
  for (std::size_t i = 0; i + 1 < hex.size(); i += 2) out.push_back(static_cast<char>(std::stoi(hex.substr(i, 2), nullptr, 16)));
  return out;
}

std::vector<Level> levels(const nlohmann::json& arr) {
  std::vector<Level> out;
  for (const auto& l : arr) out.push_back({l[0].get<hoga::Price>(), l[1].get<hoga::Qty>()});
  return out;
}

// 서버(TS)가 쓰는 JSON 모양 → C++ 메시지
Message fromJson(const nlohmann::json& j) {
  const auto t = j.at("t").get<std::string>();
  const auto sym = j.at("sym").get<std::string>();
  if (t == "snap") return SnapshotMsg{sym, j.at("seq").get<hoga::Seq>(), j.at("ts"), levels(j.at("bids")), levels(j.at("asks"))};
  if (t == "delta") {
    return DeltaMsg{sym, j.at("seq").get<hoga::Seq>(), j.at("ts"), j.at("side") == "B" ? Side::Bid : Side::Ask, j.at("px"), j.at("qty")};
  }
  return TradeMsg{sym, j.at("ts"), j.at("px"), j.at("qty"), j.at("aggr") == "A" ? Side::Ask : Side::Bid, j.at("aggr") == "N"};
}

}  // namespace

// 서버(TS) 인코더와 같은 바이트를 만들고, 같은 값으로 되읽는다
TEST(Wire, MatchesSharedGoldenVectors) {
  std::ifstream file(HOGA_SHARED_DIR "/protocol/wire-v1.json");
  ASSERT_TRUE(file.good());
  std::stringstream ss;
  ss << file.rdbuf();
  const auto doc = nlohmann::json::parse(ss.str());
  ASSERT_GE(doc.at("vectors").size(), 5u);
  for (const auto& v : doc.at("vectors")) {
    SCOPED_TRACE(v.at("name").get<std::string>());
    const auto expected = fromJson(v.at("json"));
    const auto bytes = fromHex(v.at("hex").get<std::string>());
    EXPECT_EQ(encode(expected), bytes);
    const auto decoded = decode(bytes);
    ASSERT_TRUE(decoded.has_value());
    EXPECT_EQ(*decoded, expected);
  }
}

// 이진 → JSON 문자열이 서버가 보내는 JSON과 같은 값이다(비교 실험 탭용)
TEST(Wire, ToJsonMatchesServerShape) {
  std::ifstream file(HOGA_SHARED_DIR "/protocol/wire-v1.json");
  std::stringstream ss;
  ss << file.rdbuf();
  const auto doc = nlohmann::json::parse(ss.str());  // 임시 객체의 멤버를 range-for로 돌면 수명이 끝난다
  for (const auto& v : doc.at("vectors")) {
    SCOPED_TRACE(v.at("name").get<std::string>());
    EXPECT_EQ(nlohmann::json::parse(toJson(*decode(fromHex(v.at("hex"))))), v.at("json"));
  }
}

TEST(Wire, VarintByHand) {
  // 71,200 = 0x11620 → 7비트씩: 0x20|0x80, 0x2C|0x80, 0x04
  const auto bytes = encode(DeltaMsg{"000001", 1, 0, Side::Bid, 71'200, 1});
  EXPECT_EQ(bytes.substr(10, 3), std::string("\xA0\xAC\x04", 3));
}

TEST(Wire, RejectsMalformedInput) {
  const auto good = encode(DeltaMsg{"000001", 5, 9, Side::Ask, 71'300, 7});
  ASSERT_TRUE(decode(good));
  EXPECT_FALSE(decode(""));
  EXPECT_FALSE(decode("{\"t\":\"delta\"}"));                // JSON은 이진이 아님
  EXPECT_FALSE(decode(good.substr(0, good.size() - 1)));  // 잘림
  EXPECT_FALSE(decode(good + "x"));                       // 남는 바이트
  auto badSide = good;
  badSide[10] = 7;  // seq(1) ts(1) 다음 side 자리
  EXPECT_FALSE(decode(badSide));
  // 2^53을 넘는 가격
  std::string huge = good.substr(0, 10) + std::string("\x00", 1) + std::string("\x80\x80\x80\x80\x80\x80\x80\x80\x10", 9) + "\x01";
  EXPECT_FALSE(decode(huge));
  // 단계 수를 터무니없이 크게 적은 스냅샷(메모리 공격)
  std::string snap = std::string("\x01", 1) + "000001" + std::string("\x01\x01\xff\xff\x03", 5);
  EXPECT_FALSE(decode(snap));
  // 끝나지 않는 varint
  std::string endless = std::string("\x02", 1) + "000001" + std::string(11, '\x80');
  EXPECT_FALSE(decode(endless));
}

TEST(Wire, IsBinaryLooksOnlyAtFirstByte) {
  EXPECT_TRUE(isBinary(std::string("\x02", 1)));
  EXPECT_FALSE(isBinary("{"));
  EXPECT_FALSE(isBinary(""));
  EXPECT_FALSE(isBinary(std::string("\x09", 1)));
}
