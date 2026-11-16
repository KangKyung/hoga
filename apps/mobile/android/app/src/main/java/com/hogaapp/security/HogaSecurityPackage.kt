package com.hogaapp.security

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager
import com.hogaapp.capture.DocumentCaptureModule
import com.hogaapp.chart.HogaChartViewManager

/** 앱 안에 둔 플랫폼별 TurboModule(보안 저장소·기기 보안 신호·신분증 촬영)과 네이티브 차트 뷰를 등록한다. */
class HogaSecurityPackage : BaseReactPackage() {
  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
      listOf(HogaChartViewManager())

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      when (name) {
        SecureStoreModule.NAME -> SecureStoreModule(reactContext)
        DeviceGuardModule.NAME -> DeviceGuardModule(reactContext)
        DocumentCaptureModule.NAME -> DocumentCaptureModule(reactContext)
        else -> null
      }

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    listOf(SecureStoreModule.NAME, DeviceGuardModule.NAME, DocumentCaptureModule.NAME).associateWith { name ->
      ReactModuleInfo(
          name = name,
          className = name,
          canOverrideExistingModule = false,
          needsEagerInit = false,
          isCxxModule = false,
          isTurboModule = true,
      )
    }
  }
}
