package com.hogaapp.chart

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.view.Choreographer
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max

/**
 * 네이티브 캔들 차트(Android, Kotlin + Canvas).
 *
 * - 데이터·배치: C++ (HogaChartNative.nativeLayout) — iOS와 같은 계산. 여기서는 그리기와 제스처만.
 * - 다시 그리기: Choreographer 프레임 콜백에서 봉 버전만 확인하고, 바뀌었을 때만 invalidate.
 * - 제스처: 핀치(확대·축소), 가로 드래그(스크롤), 길게 누르기(십자선 → onCrosshair).
 */
class HogaChartView(context: Context) : View(context) {
  /** 십자선 이동: null이면 손을 뗐다. [start, open, high, low, close, volume] */
  var onCrosshair: ((DoubleArray?) -> Unit)? = null

  private var symbol = ""
  private var intervalMs = 60_000L
  private var visibleBars = 60
  private var offset = 0
  var showVolume = true
    set(value) {
      field = value
      invalidate()
    }
  var showMA = true
    set(value) {
      field = value
      invalidate()
    }

  private val density = resources.displayMetrics.density
  private var data = DoubleArray(0)
  private var version = Long.MIN_VALUE
  private var crosshairX: Float? = null
  private var gestureStartBars = 60
  private var gestureStartOffset = 0
  private var dragDistance = 0f

  private val up = Color.parseColor("#D6293E")
  private val down = Color.parseColor("#1F5FD1")
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val text =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#7B8692")
        textSize = 10 * density
        typeface = Typeface.MONOSPACE
      }
  private val priceFormat = NumberFormat.getIntegerInstance(Locale.KOREA)
  private val timeFormat = SimpleDateFormat("HH:mm", Locale.KOREA)

  init {
    setBackgroundColor(Color.WHITE)
  }

  fun setSource(symbol: String, intervalMs: Long, initialBars: Int) {
    val changed = symbol != this.symbol || intervalMs != this.intervalMs
    this.symbol = symbol
    this.intervalMs = if (intervalMs > 0) intervalMs else 60_000L
    if (changed) {
      visibleBars = if (initialBars > 0) initialBars else 60
      offset = 0
      version = Long.MIN_VALUE
      invalidate()
    }
  }

  // ---------- 프레임 루프 ----------

  private val frameCallback =
      object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
          if (symbol.isNotEmpty()) {
            val v = HogaChartNative.nativeVersion(symbol)
            if (v != version) {
              version = v
              invalidate()
            }
          }
          Choreographer.getInstance().postFrameCallback(this)
        }
      }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    Choreographer.getInstance().postFrameCallback(frameCallback)
  }

  override fun onDetachedFromWindow() {
    Choreographer.getInstance().removeFrameCallback(frameCallback)
    super.onDetachedFromWindow()
  }

  // ---------- 그리기 ----------

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (symbol.isEmpty() || width == 0) return
    data =
        HogaChartNative.nativeLayout(
            symbol, intervalMs, width.toFloat(), height.toFloat(), 56 * density, 18 * density,
            if (showVolume) 0.22f else 0f, 6 * density, 16 * density, visibleBars, offset, showMA)
    val n = data[0].toInt()
    visibleBars = data[2].toInt()
    offset = data[3].toInt()
    if (n == 0) {
      canvas.drawText("차트 데이터를 불러오는 중…", 12 * density, height / 2f, text)
      return
    }
    val plotRight = data[4].toFloat()
    val priceTop = data[5].toFloat()
    val volumeBottom = data[8].toFloat()
    var i = HogaChartNative.HEADER + n * HogaChartNative.PER_CANDLE
    val ma5 = i.also { i += data[13].toInt() * 2 }
    val ma20 = i.also { i += data[14].toInt() * 2 }
    val grid = i.also { i += data[15].toInt() * 2 }
    val times = i

    // 격자·가격 눈금
    stroke.strokeWidth = 1f
    stroke.color = Color.parseColor("#E3E7EC")
    for (g in 0 until data[15].toInt()) {
      val y = data[grid + g * 2].toFloat()
      canvas.drawLine(0f, y, plotRight, y, stroke)
      canvas.drawText(priceFormat.format(data[grid + g * 2 + 1].toLong()), plotRight + 4 * density, y + 4 * density, text)
    }
    for (t in 0 until data[16].toInt()) {
      val x = data[times + t * 2].toFloat()
      // 첫 눈금이 왼쪽 끝에서 잘리지 않도록
      canvas.drawText(timeFormat.format(Date(data[times + t * 2 + 1].toLong())), max(2 * density, x - 14 * density), height - 4 * density, text)
    }

    // 거래량 → 심지 → 몸통
    for (c in 0 until n) {
      val o = HogaChartNative.HEADER + c * HogaChartNative.PER_CANDLE
      val x = data[o].toFloat()
      val half = data[o + 1].toFloat() / 2
      val color = if (data[o + 8] > 0.5) up else down
      fill.color = color
      fill.alpha = 64
      canvas.drawRect(x - half, data[o + 6].toFloat(), x + half, data[o + 7].toFloat(), fill)
      fill.alpha = 255
      stroke.color = color
      stroke.strokeWidth = max(1f, density)
      canvas.drawLine(x, data[o + 4].toFloat(), x, data[o + 5].toFloat(), stroke)
      canvas.drawRect(x - half, data[o + 2].toFloat(), x + half, data[o + 3].toFloat(), fill)
    }

    // 이동평균
    fun polyline(start: Int, count: Int, color: Int) {
      if (count < 2) return
      val path = Path().apply { moveTo(data[start].toFloat(), data[start + 1].toFloat()) }
      for (p in 1 until count) path.lineTo(data[start + p * 2].toFloat(), data[start + p * 2 + 1].toFloat())
      stroke.color = color
      stroke.strokeWidth = 1.2f * density
      canvas.drawPath(path, stroke)
    }
    polyline(ma5, data[13].toInt(), Color.parseColor("#C27A00"))
    polyline(ma20, data[14].toInt(), Color.parseColor("#7B3FBF"))

    // 마지막 체결가 선
    if (data[9] > 0.5) {
      val y = data[10].toFloat()
      val lastColor = if (data[12] > 0.5) up else down
      stroke.color = lastColor
      stroke.strokeWidth = density
      stroke.pathEffect = DashPathEffect(floatArrayOf(3 * density, 3 * density), 0f)
      canvas.drawLine(0f, y, plotRight, y, stroke)
      stroke.pathEffect = null
      fill.color = lastColor
      canvas.drawRect(plotRight + 1, y - 8 * density, width.toFloat(), y + 8 * density, fill)
      val white = Paint(text).apply { color = Color.WHITE }
      canvas.drawText(priceFormat.format(data[11].toLong()), plotRight + 3 * density, y + 4 * density, white)
    }

    // 십자선
    crosshairX?.let { cx ->
      nearest(cx)?.let { o ->
        stroke.color = Color.parseColor("#9916202C")
        stroke.strokeWidth = 1f
        canvas.drawLine(data[o].toFloat(), priceTop, data[o].toFloat(), volumeBottom, stroke)
      }
    }
  }

  /** x에 가장 가까운 봉의 배열 위치 */
  private fun nearest(x: Float): Int? {
    if (data.isEmpty()) return null
    val n = data[0].toInt()
    if (n == 0 || x > data[4]) return null
    var best = -1
    var bestDist = Float.MAX_VALUE
    for (c in 0 until n) {
      val o = HogaChartNative.HEADER + c * HogaChartNative.PER_CANDLE
      val d = abs(data[o].toFloat() - x)
      if (d < bestDist) {
        bestDist = d
        best = o
      }
    }
    return if (best >= 0) best else null
  }

  private fun emitCrosshair(x: Float?) {
    crosshairX = x
    val o = x?.let { nearest(it) }
    onCrosshair?.invoke(o?.let { data.copyOfRange(it + 9, it + 15) })
    invalidate()
  }

  // ---------- 제스처 ----------

  private val scale =
      ScaleGestureDetector(
          context,
          object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
              gestureStartBars = visibleBars
              parent?.requestDisallowInterceptTouchEvent(true)
              return true
            }

            override fun onScale(detector: ScaleGestureDetector): Boolean {
              visibleBars = (gestureStartBars / max(0.1f, detector.scaleFactor)).toInt()
              gestureStartBars = visibleBars
              invalidate()
              return true
            }
          })

  private val gestures =
      GestureDetector(
          context,
          object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean {
              gestureStartOffset = offset
              dragDistance = 0f
              return true
            }

            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
              if (crosshairX != null || scale.isInProgress) return false
              val start = e1 ?: return false
              val totalX = e2.x - start.x
              if (abs(totalX) < abs(e2.y - start.y)) return false // 세로는 부모 스크롤에 양보
              parent?.requestDisallowInterceptTouchEvent(true)
              val spacing = max(1f, (data.getOrNull(4)?.toFloat() ?: width.toFloat()) / max(1, visibleBars))
              offset = gestureStartOffset + (totalX / spacing).toInt() // 오른쪽으로 끌면 과거
              invalidate()
              return true
            }

            override fun onLongPress(e: MotionEvent) {
              parent?.requestDisallowInterceptTouchEvent(true)
              emitCrosshair(e.x)
            }
          })

  override fun onTouchEvent(event: MotionEvent): Boolean {
    scale.onTouchEvent(event)
    if (crosshairX != null) {
      when (event.actionMasked) {
        MotionEvent.ACTION_MOVE -> emitCrosshair(event.x)
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          emitCrosshair(null)
          parent?.requestDisallowInterceptTouchEvent(false)
        }
      }
      return true
    }
    gestures.onTouchEvent(event)
    if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
      parent?.requestDisallowInterceptTouchEvent(false)
    }
    return true
  }
}
