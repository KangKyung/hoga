#include "hoga/wire.hpp"

#include <algorithm>
#include <limits>
#include <type_traits>

namespace hoga::wire {
namespace {

constexpr std::size_t kSymbolLen = 6;
constexpr std::uint64_t kMaxLevels = 1'000;  // 악의적인 단계 수로 메모리를 잡지 못하게

void putVarint(std::string& out, std::uint64_t v) {
  while (v >= 0x80) {
    out.push_back(static_cast<char>((v & 0x7F) | 0x80));
    v >>= 7;
  }
  out.push_back(static_cast<char>(v));
}

void putSigned(std::string& out, std::int64_t v) { putVarint(out, static_cast<std::uint64_t>(v < 0 ? 0 : v)); }

void putHeader(std::string& out, Type type, const std::string& symbol) {
  out.push_back(static_cast<char>(type));
  out.append(symbol.substr(0, kSymbolLen));
  out.append(kSymbolLen - std::min(symbol.size(), kSymbolLen), ' ');
}

class Reader {
 public:
  explicit Reader(std::string_view b) : b_(b) {}

  bool varint(std::uint64_t& v) {
    v = 0;
    for (int shift = 0; shift < 64; shift += 7) {
      if (pos_ >= b_.size()) return false;
      const auto byte = static_cast<std::uint8_t>(b_[pos_++]);
      v |= static_cast<std::uint64_t>(byte & 0x7F) << shift;
      if ((byte & 0x80) == 0) return true;
    }
    return false;  // 10바이트를 넘는 varint
  }

  // JS number로 정확히 나타낼 수 있는 범위(2^53-1)만 받는다(앱·서버 바인딩과 같은 규칙)
  bool safe(std::int64_t& v) {
    std::uint64_t u = 0;
    if (!varint(u) || u > 9007199254740991ULL) return false;
    v = static_cast<std::int64_t>(u);
    return true;
  }

  bool byte(std::uint8_t& v) {
    if (pos_ >= b_.size()) return false;
    v = static_cast<std::uint8_t>(b_[pos_++]);
    return true;
  }

  bool symbol(std::string& out) {
    if (b_.size() - pos_ < kSymbolLen) return false;
    out.assign(b_.substr(pos_, kSymbolLen));
    pos_ += kSymbolLen;
    while (!out.empty() && out.back() == ' ') out.pop_back();
    return true;
  }

  bool side(Side& s) {
    std::uint8_t v = 0;
    if (!byte(v) || v > 1) return false;
    s = v == 0 ? Side::Bid : Side::Ask;
    return true;
  }

  bool levels(std::vector<Level>& out) {
    std::uint64_t n = 0;
    if (!varint(n) || n > kMaxLevels) return false;
    out.resize(static_cast<std::size_t>(n));
    for (auto& l : out) {
      if (!safe(l.price) || !safe(l.qty)) return false;
    }
    return true;
  }

  bool done() const { return pos_ == b_.size(); }

 private:
  std::string_view b_;
  std::size_t pos_{1};  // 종류 바이트 다음부터
};

}  // namespace

std::string encode(const Message& message) {
  std::string out;
  out.reserve(32);
  std::visit(
      [&out](const auto& m) {
        using T = std::decay_t<decltype(m)>;
        if constexpr (std::is_same_v<T, SnapshotMsg>) {
          out.reserve(16 + (m.bids.size() + m.asks.size()) * 6);
          putHeader(out, Type::Snapshot, m.symbol);
          putVarint(out, m.seq);
          putSigned(out, m.ts);
          for (const auto* side : {&m.bids, &m.asks}) {
            putVarint(out, side->size());
            for (const auto& l : *side) {
              putSigned(out, l.price);
              putSigned(out, l.qty);
            }
          }
        } else if constexpr (std::is_same_v<T, DeltaMsg>) {
          putHeader(out, Type::Delta, m.symbol);
          putVarint(out, m.seq);
          putSigned(out, m.ts);
          out.push_back(static_cast<char>(m.side == Side::Bid ? 0 : 1));
          putSigned(out, m.price);
          putSigned(out, m.qty);
        } else {
          putHeader(out, Type::Trade, m.symbol);
          putSigned(out, m.ts);
          putSigned(out, m.price);
          putSigned(out, m.qty);
          out.push_back(static_cast<char>(m.auction ? 2 : m.aggressor == Side::Bid ? 0 : 1));
        }
      },
      message);
  return out;
}

std::string toJson(const Message& message) {
  auto n = [](std::int64_t v) { return std::to_string(v); };
  auto side = [](Side s) { return s == Side::Bid ? std::string("\"B\"") : std::string("\"A\""); };
  return std::visit(
      [&](const auto& m) -> std::string {
        using T = std::decay_t<decltype(m)>;
        const std::string head = ",\"sym\":\"" + m.symbol + "\",";
        if constexpr (std::is_same_v<T, SnapshotMsg>) {
          auto levels = [&](const std::vector<Level>& ls) {
            std::string out = "[";
            for (std::size_t i = 0; i < ls.size(); ++i) out += (i ? ",[" : "[") + n(ls[i].price) + "," + n(ls[i].qty) + "]";
            return out + "]";
          };
          return "{\"t\":\"snap\"" + head + "\"seq\":" + std::to_string(m.seq) + ",\"ts\":" + n(m.ts) +
                 ",\"bids\":" + levels(m.bids) + ",\"asks\":" + levels(m.asks) + "}";
        } else if constexpr (std::is_same_v<T, DeltaMsg>) {
          return "{\"t\":\"delta\"" + head + "\"seq\":" + std::to_string(m.seq) + ",\"ts\":" + n(m.ts) +
                 ",\"side\":" + side(m.side) + ",\"px\":" + n(m.price) + ",\"qty\":" + n(m.qty) + "}";
        } else {
          return "{\"t\":\"trade\"" + head + "\"ts\":" + n(m.ts) + ",\"px\":" + n(m.price) + ",\"qty\":" +
                 n(m.qty) + ",\"aggr\":" + (m.auction ? std::string("\"N\"") : side(m.aggressor)) + "}";
        }
      },
      message);
}

std::optional<Message> decode(std::string_view bytes) {
  if (!isBinary(bytes)) return std::nullopt;
  Reader r(bytes);
  const auto type = static_cast<Type>(static_cast<std::uint8_t>(bytes[0]));
  std::uint64_t seq = 0;
  switch (type) {
    case Type::Snapshot: {
      SnapshotMsg m;
      if (!r.symbol(m.symbol) || !r.varint(seq) || !r.safe(m.ts) || !r.levels(m.bids) || !r.levels(m.asks) || !r.done()) {
        return std::nullopt;
      }
      m.seq = seq;
      return m;
    }
    case Type::Delta: {
      DeltaMsg m;
      if (!r.symbol(m.symbol) || !r.varint(seq) || !r.safe(m.ts) || !r.side(m.side) || !r.safe(m.price) || !r.safe(m.qty) ||
          !r.done()) {
        return std::nullopt;
      }
      m.seq = seq;
      return m;
    }
    case Type::Trade: {
      TradeMsg m;
      std::uint8_t aggr = 0;
      if (!r.symbol(m.symbol) || !r.safe(m.ts) || !r.safe(m.price) || !r.safe(m.qty) || !r.byte(aggr) || aggr > 2 ||
          !r.done()) {
        return std::nullopt;
      }
      m.auction = aggr == 2;
      m.aggressor = aggr == 1 ? Side::Ask : Side::Bid;
      return m;
    }
  }
  return std::nullopt;
}

}  // namespace hoga::wire
