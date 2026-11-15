package com.hogaapp.security;

import android.app.Activity;
import android.os.Build;
import android.os.Debug;
import android.view.WindowManager;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.hogaapp.specs.NativeDeviceGuardSpec;

import java.io.File;

/**
 * 기기 보안 신호(Android, Java).
 *
 * 루팅·에뮬레이터·디버거 감지는 쉽게 우회되는 "참고 신호"다. 앱에서 차단하지 않고 서버에 알려
 * 서버가 거래 제한 여부를 판단하는 것을 전제로 한다.
 */
public class DeviceGuardModule extends NativeDeviceGuardSpec {

  private static final String[] SU_PATHS = {
      "/system/bin/su", "/system/xbin/su", "/sbin/su", "/su/bin/su",
      "/data/local/su", "/data/local/bin/su", "/data/local/xbin/su", "/system/sd/xbin/su",
  };

  public DeviceGuardModule(ReactApplicationContext context) {
    super(context);
  }

  @NonNull
  @Override
  public String getName() {
    return NAME;
  }

  @Override
  public WritableMap getStatus() {
    WritableArray reasons = Arguments.createArray();
    for (String path : SU_PATHS) {
      if (new File(path).exists()) {
        reasons.pushString("su:" + path);
        break;
      }
    }
    if (Build.TAGS != null && Build.TAGS.contains("test-keys")) reasons.pushString("test-keys");

    boolean emulator = isEmulator();
    boolean debugger = Debug.isDebuggerConnected() || Debug.waitingForDebugger();

    WritableMap status = Arguments.createMap();
    status.putBoolean("compromised", reasons.size() > 0);
    status.putArray("reasons", reasons);
    status.putBoolean("emulator", emulator);
    status.putBoolean("debugger", debugger);
    // Android 14+ 캡처 감지는 별도 권한(DETECT_SCREEN_CAPTURE)이 필요하다. 대신 FLAG_SECURE로 차단한다.
    status.putBoolean("captured", false);
    return status;
  }

  @Override
  public void setSecureScreen(boolean enabled) {
    final Activity activity = getCurrentActivity();
    if (activity == null) return;
    activity.runOnUiThread(() -> {
      if (enabled) {
        activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
      } else {
        activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
      }
    });
  }

  private static boolean isEmulator() {
    return Build.FINGERPRINT.startsWith("generic")
        || Build.FINGERPRINT.contains("emulator")
        || Build.HARDWARE.contains("ranchu")
        || Build.HARDWARE.contains("goldfish")
        || Build.PRODUCT.contains("sdk");
  }
}
