package com.hogaapp.security

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** 앱 안에 둔 플랫폼별 TurboModule(보안 저장소·기기 보안 신호)을 등록한다. */
class HogaSecurityPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      when (name) {
        SecureStoreModule.NAME -> SecureStoreModule(reactContext)
        DeviceGuardModule.NAME -> DeviceGuardModule(reactContext)
        else -> null
      }

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    listOf(SecureStoreModule.NAME, DeviceGuardModule.NAME).associateWith { name ->
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
