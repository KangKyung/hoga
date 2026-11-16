// Android 플랫폼 전송 계층: C++ hoga::ITransport ↔ Kotlin com.hogaapp.transport.HogaTransport (OkHttp).
//
// JNI 규칙
// - 클래스·메서드 ID는 JNI_OnLoad(registerHogaTransportNatives)에서 한 번 찾아 전역 참조로 보관한다.
//   네이티브 스레드에서 FindClass를 하면 앱 클래스 로더를 못 찾기 때문이다.
// - Kotlin 객체는 전역 참조(NewGlobalRef)로 잡고, 소멸 시 release() 후 DeleteGlobalRef.
// - C++ 뮤텍스를 잡은 채로 Java를 부르지 않는다(교착 방지).
// - Java 호출 뒤에는 항상 예외를 확인하고 지운다.
#include <jni.h>

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>

#include "PlatformTransport.h"

namespace {

JavaVM* gVm = nullptr;
jclass gClass = nullptr;
jmethodID gCtor = nullptr;
jmethodID gConnect = nullptr;
jmethodID gSend = nullptr;
jmethodID gClose = nullptr;
jmethodID gHttpGet = nullptr;
jmethodID gSchedule = nullptr;
jmethodID gRelease = nullptr;

constexpr const char* kClassName = "com/hogaapp/transport/HogaTransport";

JNIEnv* env() {
  JNIEnv* e = nullptr;
  if (gVm->GetEnv(reinterpret_cast<void**>(&e), JNI_VERSION_1_6) == JNI_EDETACHED) {
    gVm->AttachCurrentThread(&e, nullptr);
  }
  return e;
}

void clearException(JNIEnv* e) {
  if (e->ExceptionCheck()) {
    e->ExceptionDescribe();
    e->ExceptionClear();
  }
}

// Kotlin String → std::string (UTF-8)
std::string toStd(JNIEnv* e, jstring s) {
  if (!s) return {};
  const char* chars = e->GetStringUTFChars(s, nullptr);
  std::string out(chars ? chars : "");
  if (chars) e->ReleaseStringUTFChars(s, chars);
  return out;
}

// 로컬 참조를 자동으로 지우는 jstring
struct LocalString {
  JNIEnv* e;
  jstring value;
  LocalString(JNIEnv* env, const std::string& s) : e(env), value(env->NewStringUTF(s.c_str())) {}
  ~LocalString() {
    if (value) e->DeleteLocalRef(value);
  }
};

struct Connection {
  jlong token{0};
  hoga::TransportCallbacks callbacks;
  bool finished{false};
};

class AndroidTransport final : public hoga::ITransport {
 public:
  AndroidTransport() {
    JNIEnv* e = env();
    jobject local = e->NewObject(gClass, gCtor, reinterpret_cast<jlong>(this));
    clearException(e);
    java_ = e->NewGlobalRef(local);
    e->DeleteLocalRef(local);
  }

  ~AndroidTransport() override {
    JNIEnv* e = env();
    if (java_) {
      // release()가 끝나면 Kotlin은 더 이상 이 포인터로 콜백하지 않는다.
      e->CallVoidMethod(java_, gRelease);
      clearException(e);
      e->DeleteGlobalRef(java_);
    }
  }

  void connect(const std::string& url, hoga::TransportCallbacks callbacks) override {
    jlong token;
    {
      std::lock_guard lock(mutex_);
      if (conn_) conn_->finished = true;  // 이전 연결의 늦은 이벤트는 무시
      conn_ = std::make_shared<Connection>();
      conn_->token = token = ++nextToken_;
      conn_->callbacks = std::move(callbacks);
    }
    JNIEnv* e = env();
    LocalString jurl(e, url);
    e->CallVoidMethod(java_, gConnect, token, jurl.value);
    clearException(e);
  }

  void send(const std::string& text) override {
    JNIEnv* e = env();
    LocalString jtext(e, text);
    e->CallVoidMethod(java_, gSend, jtext.value);
    clearException(e);
  }

  void close(int code, const std::string& reason) override {
    {
      std::lock_guard lock(mutex_);
      if (conn_) conn_->finished = true;  // 우리가 닫은 연결은 알리지 않는다
    }
    JNIEnv* e = env();
    LocalString jreason(e, reason);
    e->CallVoidMethod(java_, gClose, static_cast<jint>(code), jreason.value);
    clearException(e);
  }

  void httpGet(const std::string& url, std::function<void(int, std::string)> done) override {
    jint id;
    {
      std::lock_guard lock(mutex_);
      id = ++nextId_;
      http_[id] = std::move(done);
    }
    JNIEnv* e = env();
    LocalString jurl(e, url);
    e->CallVoidMethod(java_, gHttpGet, id, jurl.value);
    clearException(e);
  }

  void schedule(std::chrono::milliseconds delay, std::function<void()> fn) override {
    jint id;
    {
      std::lock_guard lock(mutex_);
      id = ++nextId_;
      timers_[id] = std::move(fn);
    }
    JNIEnv* e = env();
    e->CallVoidMethod(java_, gSchedule, id, static_cast<jlong>(delay.count()));
    clearException(e);
  }

  // ---- Kotlin → C++ (OkHttp·타이머 스레드) ----

  void onOpen(jlong token) {
    std::function<void()> fn;
    {
      std::lock_guard lock(mutex_);
      if (!conn_ || conn_->token != token || conn_->finished) return;
      fn = conn_->callbacks.onOpen;
    }
    if (fn) fn();
  }

  void onMessage(jlong token, std::string text) {
    std::function<void(std::string)> fn;
    {
      std::lock_guard lock(mutex_);
      if (!conn_ || conn_->token != token || conn_->finished) return;
      fn = conn_->callbacks.onMessage;
    }
    if (fn) fn(std::move(text));
  }

  void onClose(jlong token, int code, std::string reason) {
    std::function<void(int, std::string)> fn;
    {
      std::lock_guard lock(mutex_);
      if (!conn_ || conn_->token != token || conn_->finished) return;
      conn_->finished = true;  // 끊김은 정확히 한 번만 알린다
      fn = conn_->callbacks.onClose;
    }
    if (fn) fn(code, std::move(reason));
  }

  void onHttp(jint id, int status, std::string body) {
    std::function<void(int, std::string)> fn;
    {
      std::lock_guard lock(mutex_);
      auto it = http_.find(id);
      if (it == http_.end()) return;
      fn = std::move(it->second);
      http_.erase(it);
    }
    if (fn) fn(status, std::move(body));
  }

  void onTimer(jint id) {
    std::function<void()> fn;
    {
      std::lock_guard lock(mutex_);
      auto it = timers_.find(id);
      if (it == timers_.end()) return;
      fn = std::move(it->second);
      timers_.erase(it);
    }
    if (fn) fn();
  }

 private:
  jobject java_ = nullptr;
  std::mutex mutex_;
  std::shared_ptr<Connection> conn_;
  jlong nextToken_ = 0;
  jint nextId_ = 0;
  std::map<jint, std::function<void(int, std::string)>> http_;
  std::map<jint, std::function<void()>> timers_;
};

AndroidTransport* self(jlong ptr) { return reinterpret_cast<AndroidTransport*>(ptr); }

void JNICALL nativeOnOpen(JNIEnv*, jclass, jlong ptr, jlong token) { self(ptr)->onOpen(token); }

void JNICALL nativeOnMessage(JNIEnv* e, jclass, jlong ptr, jlong token, jstring text) {
  self(ptr)->onMessage(token, toStd(e, text));
}

void JNICALL nativeOnBinary(JNIEnv* e, jclass, jlong ptr, jlong token, jbyteArray bytes) {
  const auto n = e->GetArrayLength(bytes);
  std::string out(static_cast<std::size_t>(n), '\0');
  e->GetByteArrayRegion(bytes, 0, n, reinterpret_cast<jbyte*>(out.data()));
  self(ptr)->onMessage(token, std::move(out));
}

void JNICALL nativeOnClose(JNIEnv* e, jclass, jlong ptr, jlong token, jint code, jstring reason) {
  self(ptr)->onClose(token, code, toStd(e, reason));
}

void JNICALL nativeOnHttp(JNIEnv* e, jclass, jlong ptr, jint id, jint status, jstring body) {
  self(ptr)->onHttp(id, status, toStd(e, body));
}

void JNICALL nativeOnTimer(JNIEnv*, jclass, jlong ptr, jint id) { self(ptr)->onTimer(id); }

}  // namespace

namespace hoga::platform {

std::shared_ptr<ITransport> makePlatformTransport() { return std::make_shared<AndroidTransport>(); }

// OnLoad.cpp의 JNI_OnLoad에서 호출. 앱 클래스 로더가 보이는 시점에 클래스·메서드를 찾아 둔다.
bool registerHogaTransportNatives(JavaVM* vm, JNIEnv* e) {
  gVm = vm;
  jclass local = e->FindClass(kClassName);
  if (!local) {
    clearException(e);
    return false;
  }
  gClass = static_cast<jclass>(e->NewGlobalRef(local));
  e->DeleteLocalRef(local);

  gCtor = e->GetMethodID(gClass, "<init>", "(J)V");
  gConnect = e->GetMethodID(gClass, "connect", "(JLjava/lang/String;)V");
  gSend = e->GetMethodID(gClass, "send", "(Ljava/lang/String;)V");
  gClose = e->GetMethodID(gClass, "close", "(ILjava/lang/String;)V");
  gHttpGet = e->GetMethodID(gClass, "httpGet", "(ILjava/lang/String;)V");
  gSchedule = e->GetMethodID(gClass, "schedule", "(IJ)V");
  gRelease = e->GetMethodID(gClass, "release", "()V");

  static const JNINativeMethod methods[] = {
      {"nativeOnOpen", "(JJ)V", reinterpret_cast<void*>(nativeOnOpen)},
      {"nativeOnMessage", "(JJLjava/lang/String;)V", reinterpret_cast<void*>(nativeOnMessage)},
      {"nativeOnBinary", "(JJ[B)V", reinterpret_cast<void*>(nativeOnBinary)},
      {"nativeOnClose", "(JJILjava/lang/String;)V", reinterpret_cast<void*>(nativeOnClose)},
      {"nativeOnHttp", "(JIILjava/lang/String;)V", reinterpret_cast<void*>(nativeOnHttp)},
      {"nativeOnTimer", "(JI)V", reinterpret_cast<void*>(nativeOnTimer)},
  };
  const bool ok = e->RegisterNatives(gClass, methods, sizeof(methods) / sizeof(methods[0])) == JNI_OK;
  clearException(e);
  return ok && gCtor && gConnect && gSend && gClose && gHttpGet && gSchedule && gRelease;
}

}  // namespace hoga::platform
