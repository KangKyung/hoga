#include <gtest/gtest.h>

#include "hoga/session.hpp"

using hoga::MarketPhase;
using hoga::ViKind;

TEST(Session, PhaseFollowsKrxRegularHours) {
  EXPECT_EQ(hoga::phaseAt(8 * 60 + 29), MarketPhase::Closed);
  EXPECT_EQ(hoga::phaseAt(8 * 60 + 30), MarketPhase::PreOpen);
  EXPECT_EQ(hoga::phaseAt(8 * 60 + 59), MarketPhase::PreOpen);
  EXPECT_EQ(hoga::phaseAt(9 * 60), MarketPhase::Open);
  EXPECT_EQ(hoga::phaseAt(15 * 60 + 19), MarketPhase::Open);
  EXPECT_EQ(hoga::phaseAt(15 * 60 + 20), MarketPhase::Closing);
  EXPECT_EQ(hoga::phaseAt(15 * 60 + 30), MarketPhase::Closed);
  EXPECT_EQ(hoga::toString(MarketPhase::Closing), "CLOSING");
}

TEST(Session, StaticViWinsOverDynamic) {
  const hoga::ViPolicy policy{1000, 300};
  // 기준 10,000 → 11,000(+10%)은 정적, 직전 10,700 → 11,000(+2.8%)은 동적 아님
  EXPECT_EQ(hoga::checkVi(10'000, 10'700, 11'000, policy), ViKind::Static);
  EXPECT_EQ(hoga::checkVi(10'000, 10'700, 10'990, policy), ViKind::None);
  // 직전가 대비 3% 이상 → 동적
  EXPECT_EQ(hoga::checkVi(10'000, 10'000, 10'300, policy), ViKind::Dynamic);
  EXPECT_EQ(hoga::checkVi(10'000, 10'000, 9'700, policy), ViKind::Dynamic);
  EXPECT_EQ(hoga::checkVi(10'000, 10'000, 10'290, policy), ViKind::None);
}

TEST(Session, ZeroReferenceSkipsThatCheck) {
  const hoga::ViPolicy policy{};
  EXPECT_EQ(hoga::checkVi(0, 10'000, 10'300, policy), ViKind::Dynamic);
  EXPECT_EQ(hoga::checkVi(0, 0, 99'999, policy), ViKind::None);
  EXPECT_EQ(hoga::checkVi(10'000, 10'000, 0, policy), ViKind::None);
}
