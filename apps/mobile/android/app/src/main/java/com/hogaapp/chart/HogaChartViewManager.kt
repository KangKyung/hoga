package com.hogaapp.chart

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.events.Event
import com.facebook.react.viewmanagers.HogaChartViewManagerDelegate
import com.facebook.react.viewmanagers.HogaChartViewManagerInterface

/** Fabric 뷰 매니저. props 처리는 Codegen이 만든 Delegate/Interface를 따른다. */
@ReactModule(name = HogaChartViewManager.NAME)
class HogaChartViewManager : SimpleViewManager<HogaChartView>(), HogaChartViewManagerInterface<HogaChartView> {
  private val delegate = HogaChartViewManagerDelegate(this)

  override fun getDelegate(): ViewManagerDelegate<HogaChartView> = delegate

  override fun getName(): String = NAME

  override fun createViewInstance(context: ThemedReactContext): HogaChartView =
      HogaChartView(context).also { view ->
        view.onCrosshair = { candle -> dispatchCrosshair(context, view, candle) }
      }

  // symbol·intervalMs·initialBars는 함께 적용해야 해서 마지막 값을 모아 둔다
  private val pending = mutableMapOf<Int, Triple<String, Long, Int>>()

  private fun apply(view: HogaChartView, update: (Triple<String, Long, Int>) -> Triple<String, Long, Int>) {
    val next = update(pending[view.id] ?: Triple("", 60_000L, 60))
    pending[view.id] = next
    view.setSource(next.first, next.second, next.third)
  }

  override fun setSymbol(view: HogaChartView, value: String?) = apply(view) { it.copy(first = value ?: "") }

  override fun setIntervalMs(view: HogaChartView, value: Int) = apply(view) { it.copy(second = value.toLong()) }

  override fun setInitialBars(view: HogaChartView, value: Int) = apply(view) { it.copy(third = value) }

  override fun setShowVolume(view: HogaChartView, value: Boolean) {
    view.showVolume = value
  }

  override fun setShowMA(view: HogaChartView, value: Boolean) {
    view.showMA = value
  }

  override fun onDropViewInstance(view: HogaChartView) {
    pending.remove(view.id)
    super.onDropViewInstance(view)
  }

  override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> =
      mapOf(CrosshairEvent.NAME to mapOf("registrationName" to "onCrosshair"))

  private fun dispatchCrosshair(context: ReactContext, view: HogaChartView, candle: DoubleArray?) {
    val dispatcher = UIManagerHelper.getEventDispatcher(context) ?: return
    dispatcher.dispatchEvent(CrosshairEvent(UIManagerHelper.getSurfaceId(view), view.id, candle))
  }

  private class CrosshairEvent(surfaceId: Int, viewId: Int, private val candle: DoubleArray?) :
      Event<CrosshairEvent>(surfaceId, viewId) {
    override fun getEventName() = NAME

    override fun getEventData(): WritableMap =
        Arguments.createMap().apply {
          putBoolean("active", candle != null)
          val keys = arrayOf("start", "open", "high", "low", "close", "volume")
          keys.forEachIndexed { i, key -> putDouble(key, candle?.get(i) ?: 0.0) }
        }

    companion object {
      const val NAME = "topCrosshair"
    }
  }

  companion object {
    const val NAME = "HogaChartView"
  }
}
