require "json"

# hoga-core(C++) + C++ TurboModule을 iOS 앱에 포함하는 로컬 Pod.
# apps/mobile/ios/Podfile에서 :path로 참조한다. Android는 CMake로 같은 소스를 빌드한다.
Pod::Spec.new do |s|
  s.name         = "HogaNative"
  s.version      = "0.0.1"
  s.summary      = "Shared C++ trading core and its React Native C++ TurboModule"
  s.homepage     = "https://github.com/KangKyung/hoga"
  s.license      = { :type => "MIT" }
  s.authors      = "KangKyung"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/KangKyung/hoga.git", :tag => s.version.to_s }

  s.source_files = [
    "core/include/**/*.hpp",
    "core/src/**/*.cpp",
    "bindings/turbomodule/*.{h,cpp}",
    "bindings/turbomodule/ios/*.{h,mm}",
    "bindings/platform-modules/ios/*.{h,m,mm}",
  ]
  # 보안 저장소(Keychain·생체 인증)와 기기 보안 신호
  s.frameworks   = "Security", "LocalAuthentication", "UIKit", "QuartzCore"
  s.private_header_files = "core/include/**/*.hpp", "bindings/turbomodule/*.h"

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/core/include\" \"$(PODS_TARGET_SRCROOT)/core/third_party\"",
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
  }

  install_modules_dependencies(s)
end
