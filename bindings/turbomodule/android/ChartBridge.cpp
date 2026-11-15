// Android 차트 JNI 다리: Kotlin HogaChartView → C++ 봉 + 배치 계산(hoga::chart::layout).
//
// 프레임마다 JNI를 여러 번 넘나들지 않도록, 한 번의 호출로 그리기에 필요한 값을 double[] 하나에 담아 돌려준다.
// 배열 구조는 HogaChartNative.kt의 주석과 같다(HEADER 17칸 → 봉 15칸씩 → MA5 → MA20 → 격자 → 시간).
#include <jni.h>

#include <string>
#include <vector>

#include "ChartDataSource.h"
#include "hoga/chart_layout.hpp"

namespace {

constexpr const char* kClassName = "com/hogaapp/chart/HogaChartNative";
constexpr int kHeader = 17;
constexpr int kPerCandle = 15;

std::string toStd(JNIEnv* e, jstring s) {
  if (!s) return {};
  const char* chars = e->GetStringUTFChars(s, nullptr);
  std::string out(chars ? chars : "");
  if (chars) e->ReleaseStringUTFChars(s, chars);
  return out;
}

jlong JNICALL nativeVersion(JNIEnv* e, jclass, jstring symbol) {
  return static_cast<jlong>(hoga::chartsource::version(toStd(e, symbol)));
}

jdoubleArray JNICALL nativeLayout(JNIEnv* e, jclass, jstring symbol, jlong intervalMs, jfloat width, jfloat height,
                                  jfloat rightAxis, jfloat bottomAxis, jfloat volumeRatio, jfloat gap,
                                  jfloat labelHeight, jint visibleBars,
                                  jint offset, jboolean showMA) {
  const auto bars = hoga::chartsource::candles(toStd(e, symbol), intervalMs == 60'000 ? 0 : intervalMs, 600);
  hoga::chart::Viewport vp;
  vp.width = width;
  vp.height = height;
  vp.rightAxis = rightAxis;
  vp.bottomAxis = bottomAxis;
  vp.volumeRatio = volumeRatio;
  vp.gap = gap;
  vp.labelHeight = labelHeight;
  const auto window = hoga::chart::clampWindow({visibleBars, offset}, bars.size());
  const auto l = hoga::chart::layout(bars, vp, window, showMA == JNI_TRUE);

  std::vector<double> out;
  out.reserve(kHeader + l.candles.size() * kPerCandle + (l.ma5.size() + l.ma20.size() + l.grid.size() + l.times.size()) * 2);
  const bool lastUp = bars.size() >= 2 && bars.back().close >= bars[bars.size() - 2].close;
  out.insert(out.end(), {static_cast<double>(l.candles.size()), static_cast<double>(l.firstIndex),
                         static_cast<double>(window.visibleBars), static_cast<double>(window.offset), l.plotRight,
                         l.priceTop, l.priceBottom, l.volumeTop, l.volumeBottom, l.last ? 1.0 : 0.0,
                         l.last ? l.last->y : 0.0, l.last ? static_cast<double>(l.last->price) : 0.0, lastUp ? 1.0 : 0.0,
                         static_cast<double>(l.ma5.size()), static_cast<double>(l.ma20.size()),
                         static_cast<double>(l.grid.size()), static_cast<double>(l.times.size())});
  for (std::size_t i = 0; i < l.candles.size(); ++i) {
    const auto& s = l.candles[i];
    const auto& c = bars[static_cast<std::size_t>(l.firstIndex) + i];
    out.insert(out.end(), {s.x, s.width, s.bodyTop, s.bodyBottom, s.wickTop, s.wickBottom, s.volumeTop, s.volumeBottom,
                           s.up ? 1.0 : 0.0, static_cast<double>(c.start), static_cast<double>(c.open),
                           static_cast<double>(c.high), static_cast<double>(c.low), static_cast<double>(c.close),
                           static_cast<double>(c.volume)});
  }
  for (const auto& p : l.ma5) out.insert(out.end(), {p.x, p.y});
  for (const auto& p : l.ma20) out.insert(out.end(), {p.x, p.y});
  for (const auto& g : l.grid) out.insert(out.end(), {g.y, static_cast<double>(g.price)});
  for (const auto& t : l.times) out.insert(out.end(), {t.x, static_cast<double>(t.time)});

  jdoubleArray array = e->NewDoubleArray(static_cast<jsize>(out.size()));
  if (array) e->SetDoubleArrayRegion(array, 0, static_cast<jsize>(out.size()), out.data());
  return array;
}

}  // namespace

namespace hoga::platform {

bool registerChartNatives(JNIEnv* e) {
  jclass cls = e->FindClass(kClassName);
  if (!cls) {
    e->ExceptionClear();
    return false;
  }
  static const JNINativeMethod methods[] = {
      {"nativeVersion", "(Ljava/lang/String;)J", reinterpret_cast<void*>(nativeVersion)},
      {"nativeLayout", "(Ljava/lang/String;JFFFFFFFIIZ)[D", reinterpret_cast<void*>(nativeLayout)},
  };
  const bool ok = e->RegisterNatives(cls, methods, sizeof(methods) / sizeof(methods[0])) == JNI_OK;
  if (e->ExceptionCheck()) e->ExceptionClear();
  e->DeleteLocalRef(cls);
  return ok;
}

}  // namespace hoga::platform
