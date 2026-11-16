package com.hogaapp

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // 앱 안의 플랫폼별 TurboModule(보안 저장소·기기 보안 신호)
          add(com.hogaapp.security.HogaSecurityPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // 이전 프로세스가 카메라 앱을 띄운 채 죽었으면 신분증 원본 사진(EXIF 포함)이 캐시에 남는다 → 시작할 때 정리
    Thread({ com.hogaapp.capture.DocumentCaptureModule.clearLeftovers(this) }, "hoga-cleanup").start()
    loadReactNative(this)
  }
}
