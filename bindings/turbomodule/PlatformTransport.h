#pragma once

#include <memory>

#include "hoga/transport.hpp"

namespace hoga::platform {

// 플랫폼별 구현이 하나씩 링크된다.
//   iOS:     ios/IosTransport.mm        (URLSessionWebSocketTask, Objective-C++)
//   Android: android/AndroidTransport.cpp (OkHttp를 쓰는 Kotlin 클래스를 JNI로 호출)
std::shared_ptr<ITransport> makePlatformTransport();

}  // namespace hoga::platform
