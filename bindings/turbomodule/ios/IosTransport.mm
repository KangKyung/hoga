// iOS 플랫폼 전송 계층: URLSessionWebSocketTask(웹소켓) + URLSession(HTTP) + GCD(타이머).
// C++ 코어의 hoga::ITransport를 Objective-C++로 구현한다.
#import <Foundation/Foundation.h>

#include <atomic>
#include <memory>
#include <mutex>

#include "PlatformTransport.h"

namespace {

// 한 번의 연결에 대한 상태. 끊김 알림은 정확히 한 번만 보낸다.
struct Connection {
  hoga::TransportCallbacks callbacks;
  std::atomic<bool> finished{false};

  void finish(int code, std::string reason) {
    if (finished.exchange(true)) return;
    if (callbacks.onClose) callbacks.onClose(code, std::move(reason));
  }
};

constexpr int kAbnormalClosure = 1006;

std::string toStd(NSString *s) { return s ? std::string(s.UTF8String ?: "") : std::string(); }

}  // namespace

// 연결마다 하나. 세션이 delegate를 강하게 잡으므로 연결을 바꿀 때 세션을 invalidate해 순환을 끊는다.
@interface HGWebSocketDelegate : NSObject <NSURLSessionWebSocketDelegate>
- (instancetype)initWithConnection:(std::shared_ptr<Connection>)connection;
@end

@implementation HGWebSocketDelegate {
  std::shared_ptr<Connection> _connection;
}

- (instancetype)initWithConnection:(std::shared_ptr<Connection>)connection
{
  if (self = [super init]) {
    _connection = std::move(connection);
  }
  return self;
}

- (void)URLSession:(NSURLSession *)session
          webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask
    didOpenWithProtocol:(NSString *)protocol
{
  if (!_connection->finished && _connection->callbacks.onOpen) _connection->callbacks.onOpen();
}

- (void)URLSession:(NSURLSession *)session
       webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask
    didCloseWithCode:(NSURLSessionWebSocketCloseCode)closeCode
              reason:(NSData *)reason
{
  NSString *text = reason ? [[NSString alloc] initWithData:reason encoding:NSUTF8StringEncoding] : nil;
  _connection->finish(static_cast<int>(closeCode), toStd(text));
}

- (void)URLSession:(NSURLSession *)session
                    task:(NSURLSessionTask *)task
    didCompleteWithError:(NSError *)error
{
  // 연결 실패·네트워크 끊김. 정상 종료라면 didCloseWithCode가 먼저 와서 여기서는 무시된다.
  _connection->finish(kAbnormalClosure, toStd(error.localizedDescription));
}

@end

namespace {

class IosTransport final : public hoga::ITransport {
 public:
  IosTransport()
  {
    NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    config.timeoutIntervalForRequest = 5;
    config.waitsForConnectivity = NO;
    httpSession_ = [NSURLSession sessionWithConfiguration:config];
    timerQueue_ = dispatch_get_global_queue(QOS_CLASS_UTILITY, 0);
  }

  ~IosTransport() override
  {
    std::lock_guard lock(mutex_);
    closeLocked(1001, "going away");
    [httpSession_ invalidateAndCancel];
  }

  void connect(const std::string &url, hoga::TransportCallbacks callbacks) override
  {
    std::lock_guard lock(mutex_);
    closeLocked(1000, "reconnect");

    auto connection = std::make_shared<Connection>();
    connection->callbacks = std::move(callbacks);

    NSURL *nsUrl = [NSURL URLWithString:[NSString stringWithUTF8String:url.c_str()]];
    if (!nsUrl) {
      dispatch_async(timerQueue_, ^{ connection->finish(kAbnormalClosure, "invalid url"); });
      return;
    }

    NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    config.timeoutIntervalForRequest = 10;
    NSOperationQueue *queue = [NSOperationQueue new];
    queue.maxConcurrentOperationCount = 1;  // 콜백 순서 보장
    HGWebSocketDelegate *delegate = [[HGWebSocketDelegate alloc] initWithConnection:connection];
    session_ = [NSURLSession sessionWithConfiguration:config delegate:delegate delegateQueue:queue];
    task_ = [session_ webSocketTaskWithURL:nsUrl];
    task_.maximumMessageSize = 1 << 20;
    connection_ = connection;
    [task_ resume];
    receiveNext(task_, connection);
  }

  void send(const std::string &text) override
  {
    std::lock_guard lock(mutex_);
    if (!task_) return;
    NSURLSessionWebSocketMessage *message =
        [[NSURLSessionWebSocketMessage alloc] initWithString:[NSString stringWithUTF8String:text.c_str()]];
    auto connection = connection_;
    [task_ sendMessage:message
        completionHandler:^(NSError *error) {
          if (error) connection->finish(kAbnormalClosure, toStd(error.localizedDescription));
        }];
  }

  void close(int code, const std::string &reason) override
  {
    std::lock_guard lock(mutex_);
    closeLocked(code, reason);
  }

  void httpGet(const std::string &url, std::function<void(int, std::string)> done) override
  {
    NSURL *nsUrl = [NSURL URLWithString:[NSString stringWithUTF8String:url.c_str()]];
    if (!nsUrl) {
      dispatch_async(timerQueue_, ^{ done(0, ""); });
      return;
    }
    NSURLSessionDataTask *task = [httpSession_
          dataTaskWithURL:nsUrl
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
          const int status = error ? 0 : static_cast<int>(((NSHTTPURLResponse *)response).statusCode);
          std::string body;
          if (data.length > 0) body.assign(static_cast<const char *>(data.bytes), data.length);
          done(status, std::move(body));
        }];
    [task resume];
  }

  void schedule(std::chrono::milliseconds delay, std::function<void()> fn) override
  {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, static_cast<int64_t>(delay.count()) * NSEC_PER_MSEC),
                   timerQueue_, ^{ fn(); });
  }

 private:
  // 수신은 한 번에 하나씩: 받을 때마다 다음 수신을 건다.
  static void receiveNext(NSURLSessionWebSocketTask *task, std::shared_ptr<Connection> connection)
  {
    __weak NSURLSessionWebSocketTask *weakTask = task;
    [task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
      if (error || connection->finished) {
        if (error) connection->finish(kAbnormalClosure, toStd(error.localizedDescription));
        return;
      }
      if (connection->callbacks.onMessage) {
        if (message.type == NSURLSessionWebSocketMessageTypeString) {
          connection->callbacks.onMessage(toStd(message.string));
        } else if (message.data.length > 0) {
          // 이진 시세(wire v1): 바이트를 그대로 넘기면 C++ MarketClient가 첫 바이트로 형식을 가린다
          connection->callbacks.onMessage(
              std::string(static_cast<const char *>(message.data.bytes), static_cast<std::size_t>(message.data.length)));
        }
      }
      NSURLSessionWebSocketTask *strongTask = weakTask;
      if (strongTask) receiveNext(strongTask, connection);
    }];
  }

  void closeLocked(int code, const std::string &reason)
  {
    if (connection_) {
      // 우리가 닫은 연결은 알림을 보내지 않는다(호출자가 이미 알고 있다).
      connection_->finished = true;
      connection_.reset();
    }
    if (task_) {
      NSData *data = [[NSString stringWithUTF8String:reason.c_str()] dataUsingEncoding:NSUTF8StringEncoding];
      [task_ cancelWithCloseCode:static_cast<NSURLSessionWebSocketCloseCode>(code) reason:data];
      task_ = nil;
    }
    if (session_) {
      [session_ invalidateAndCancel];
      session_ = nil;
    }
  }

  std::mutex mutex_;
  NSURLSession *session_ = nil;
  NSURLSessionWebSocketTask *task_ = nil;
  std::shared_ptr<Connection> connection_;
  NSURLSession *httpSession_ = nil;
  dispatch_queue_t timerQueue_;
};

}  // namespace

namespace hoga::platform {

std::shared_ptr<ITransport> makePlatformTransport()
{
  return std::make_shared<IosTransport>();
}

}  // namespace hoga::platform
