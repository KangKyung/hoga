package com.hogaapp.chart

import androidx.annotation.Keep

/**
 * C++ 차트 함수(JNI). 구현: bindings/turbomodule/android/ChartBridge.cpp, 등록: OnLoad.cpp(JNI_OnLoad).
 *
 * nativeLayout 결과 double[] 구조
 *   [0..16] HEADER: 봉 수, 첫 봉 인덱스, visibleBars, offset, plotRight, priceTop, priceBottom,
 *                   volumeTop, volumeBottom, 마지막가 선 있음(0/1), 마지막가 y, 마지막가, 마지막 상승(0/1),
 *                   MA5 점 수, MA20 점 수, 격자 수, 시간 눈금 수
 *   봉마다 15칸: x, width, bodyTop, bodyBottom, wickTop, wickBottom, volumeTop, volumeBottom, up(0/1),
 *               start, open, high, low, close, volume
 *   MA5 (x, y)…, MA20 (x, y)…, 격자 (y, price)…, 시간 (x, time)…
 */
@Keep
object HogaChartNative {
  const val HEADER = 17
  const val PER_CANDLE = 15

  @JvmStatic external fun nativeVersion(symbol: String): Long

  @JvmStatic
  external fun nativeLayout(
      symbol: String,
      intervalMs: Long,
      width: Float,
      height: Float,
      rightAxis: Float,
      bottomAxis: Float,
      volumeRatio: Float,
      gap: Float,
      labelHeight: Float,
      visibleBars: Int,
      offset: Int,
      showMA: Boolean,
  ): DoubleArray
}
