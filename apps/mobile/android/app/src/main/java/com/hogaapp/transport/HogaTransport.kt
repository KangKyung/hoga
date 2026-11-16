package com.hogaapp.transport

import androidx.annotation.Keep
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * Android 플랫폼 전송 계층. C++ 코어의 hoga::ITransport 구현(AndroidTransport.cpp)이 JNI로 만들고 호출한다.
 *
 * - 웹소켓·HTTP: OkHttp (OS 네트워크 스택, 인증서 고정 등은 OkHttpClient 설정으로 붙인다)
 * - 타이머: 단일 스레드 ScheduledExecutorService
 * - 결과는 native* 함수로 C++에 돌려준다. 어떤 연결의 이벤트인지 token으로 구분하고,
 *   오래된 token의 이벤트는 C++ 쪽이 무시한다.
 *
 * 잠금 규칙(교착 방지)
 * - callbackLock: C++로 콜백을 넘길 때와 release()에서만 쓴다. release() 후에는 콜백이 C++로 가지 않는다.
 * - 소켓 조작(connect/send/close)은 callbackLock을 잡지 않는다. C++가 자기 락을 잡은 채
 *   send를 부를 수 있기 때문이다.
 */
@Keep
class HogaTransport(nativePtr: Long) {
  private val callbackLock = Any()
  @Volatile private var nativePtr: Long = nativePtr
  @Volatile private var socket: WebSocket? = null

  @Keep
  fun connect(token: Long, url: String) {
    socket?.cancel()
    val request =
        try {
          Request.Builder().url(url).build()
        } catch (e: IllegalArgumentException) {
          deliver { ptr -> nativeOnClose(ptr, token, ABNORMAL_CLOSURE, "invalid url") }
          return
        }
    socket = client.newWebSocket(request, Listener(token))
  }

  @Keep
  fun send(text: String) {
    socket?.send(text)
  }

  @Keep
  fun close(code: Int, reason: String) {
    val current = socket
    socket = null
    if (current?.close(code, reason) != true) current?.cancel()
  }

  @Keep
  fun httpGet(requestId: Int, url: String) {
    val request =
        try {
          Request.Builder().url(url).get().build()
        } catch (e: IllegalArgumentException) {
          deliver { ptr -> nativeOnHttp(ptr, requestId, 0, "") }
          return
        }
    httpClient
        .newCall(request)
        .enqueue(
            object : Callback {
              override fun onFailure(call: Call, e: IOException) {
                deliver { ptr -> nativeOnHttp(ptr, requestId, 0, "") }
              }

              override fun onResponse(call: Call, response: Response) {
                val body = response.use { it.body?.string().orEmpty() }
                deliver { ptr -> nativeOnHttp(ptr, requestId, response.code, body) }
              }
            })
  }

  @Keep
  fun schedule(timerId: Int, delayMs: Long) {
    timers.schedule({ deliver { ptr -> nativeOnTimer(ptr, timerId) } }, delayMs, TimeUnit.MILLISECONDS)
  }

  /** C++ 객체가 사라질 때 호출. 이후 어떤 콜백도 C++로 가지 않는다. */
  @Keep
  fun release() {
    synchronized(callbackLock) { nativePtr = 0 }
    close(GOING_AWAY, "released")
  }

  private inline fun deliver(block: (Long) -> Unit) {
    synchronized(callbackLock) {
      val ptr = nativePtr
      if (ptr != 0L) block(ptr)
    }
  }

  private inner class Listener(private val token: Long) : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      deliver { ptr -> nativeOnOpen(ptr, token) }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      deliver { ptr -> nativeOnMessage(ptr, token, text) }
    }

    // 이진 시세(wire v1). 바이트 배열 그대로 C++로 넘긴다(문자열로 바꾸면 UTF-8 변환에서 깨진다)
    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      val array = bytes.toByteArray()
      deliver { ptr -> nativeOnBinary(ptr, token, array) }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(code, null)
      deliver { ptr -> nativeOnClose(ptr, token, code, reason) }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      deliver { ptr -> nativeOnClose(ptr, token, ABNORMAL_CLOSURE, t.message ?: "failure") }
    }
  }

  companion object {
    private const val ABNORMAL_CLOSURE = 1006
    private const val GOING_AWAY = 1001

    // 웹소켓은 읽기 타임아웃 없이 오래 유지하고, 하트비트는 서버 ping에 OkHttp가 자동 응답한다.
    private val client: OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()

    private val httpClient: OkHttpClient =
        client.newBuilder().readTimeout(5, TimeUnit.SECONDS).callTimeout(5, TimeUnit.SECONDS).build()

    private val timers: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "hoga-timer").apply { isDaemon = true } }

    @JvmStatic private external fun nativeOnOpen(ptr: Long, token: Long)

    @JvmStatic private external fun nativeOnMessage(ptr: Long, token: Long, text: String)

    @JvmStatic private external fun nativeOnBinary(ptr: Long, token: Long, bytes: ByteArray)

    @JvmStatic private external fun nativeOnClose(ptr: Long, token: Long, code: Int, reason: String)

    @JvmStatic private external fun nativeOnHttp(ptr: Long, requestId: Int, status: Int, body: String)

    @JvmStatic private external fun nativeOnTimer(ptr: Long, timerId: Int)
  }
}
