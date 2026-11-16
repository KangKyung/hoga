#pragma once

#include <cstdint>
#include <string_view>

#include "hoga/types.hpp"

namespace hoga {

// 장 운영 구간(KRX 정규장을 단순화).
enum class MarketPhase : std::uint8_t {
  PreOpen,  // 08:30~09:00 장 시작 동시호가(단일가)
  Open,     // 09:00~15:20 접속매매
  Closing,  // 15:20~15:30 장 마감 동시호가(단일가)
  Closed,   // 그 외: 주문 접수 안 함
};

std::string_view toString(MarketPhase phase) noexcept;

// 서울 시각(분 단위, 0~1439)으로 정규장 구간을 고른다. 주말·휴장일은 호출하는 쪽이 판단한다.
MarketPhase phaseAt(int minuteOfDayKst) noexcept;

// 변동성완화장치(VI). 발동되면 그 종목만 일정 시간 단일가매매로 바뀐다.
enum class ViKind : std::uint8_t {
  None,
  Static,   // 정적 VI: 기준가(시가 등)에서 일정 비율 이상 벗어남
  Dynamic,  // 동적 VI: 직전 체결가에서 한 번에 일정 비율 이상 움직임
};

std::string_view toString(ViKind kind) noexcept;

struct ViPolicy {
  int staticBps{1000};  // 10%
  int dynamicBps{300};  // 3%
};

// price가 staticRef·dynamicRef에서 얼마나 벗어났는지 보고 VI 종류를 고른다(정적이 우선).
// 기준가가 0 이하이면 그 검사는 건너뛴다.
ViKind checkVi(Price staticRef, Price dynamicRef, Price price, const ViPolicy& policy) noexcept;

}  // namespace hoga
