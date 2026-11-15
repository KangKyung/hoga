#pragma once

#include <chrono>
#include <functional>
#include <string>

namespace hoga {

struct TransportCallbacks {
  std::function<void()> onOpen;
  std::function<void(std::string text)> onMessage;
  // 연결이 끊김(서버 종료·네트워크 오류 모두). code는 WebSocket close code, 오류면 1006.
  std::function<void(int code, std::string reason)> onClose;
};

/**
 * 플랫폼이 제공하는 네트워크·타이머.
 *
 * 소켓은 OS 구현을 쓴다(iOS URLSession / Android OkHttp): 프록시·VPN·망 전환·인증서 고정을
 * OS 기능 그대로 쓰기 위해서다. C++ 코어는 이 인터페이스만 알고 플랫폼을 모른다.
 *
 * 규칙
 * - 콜백은 어느 스레드에서 와도 된다(MarketClient가 직렬화한다).
 * - 메서드 안에서 콜백을 동기로 부르면 안 된다(호출자가 락을 잡고 있을 수 있다).
 * - connect를 다시 부르면 이전 연결은 닫고 새로 연결한다.
 */
class ITransport {
 public:
  virtual ~ITransport() = default;

  virtual void connect(const std::string& url, TransportCallbacks callbacks) = 0;
  virtual void send(const std::string& text) = 0;
  virtual void close(int code, const std::string& reason) = 0;

  // HTTP GET. 네트워크 오류는 status 0.
  virtual void httpGet(const std::string& url, std::function<void(int status, std::string body)> done) = 0;

  // delay 후 fn 실행(백그라운드 스레드 가능).
  virtual void schedule(std::chrono::milliseconds delay, std::function<void()> fn) = 0;
};

}  // namespace hoga
