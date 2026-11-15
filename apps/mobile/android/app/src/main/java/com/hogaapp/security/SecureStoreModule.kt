package com.hogaapp.security

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.hogaapp.specs.NativeSecureStoreSpec
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 보안 저장소(Android).
 *
 * - 값은 Android Keystore 안의 AES-256-GCM 키로 암호화해 SharedPreferences에 IV와 함께 저장한다.
 *   키 자체는 하드웨어 보안 영역에 있고 앱 밖으로 꺼낼 수 없다.
 * - 생체 보호 값은 "사용할 때마다 인증"이 필요한 별도 키로 암호화한다. Cipher를 BiometricPrompt의
 *   CryptoObject로 넘기므로, 인증을 통과해야만 그 Cipher로 복호화할 수 있다(단순 성공 콜백 우회 불가).
 * - 지문을 새로 등록하면 생체 키가 무효화된다(setInvalidatedByBiometricEnrollment) → E_INVALIDATED.
 */
class SecureStoreModule(private val context: ReactApplicationContext) : NativeSecureStoreSpec(context) {

  private val prefs by lazy { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

  override fun getName(): String = NAME

  override fun setItem(key: String, value: String, requireBiometrics: Boolean, prompt: String, promise: Promise) {
    try {
      if (!requireBiometrics) {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key(PLAIN_ALIAS, false)) }
        save(key, cipher, value, biometric = false)
        promise.resolve(null)
        return
      }
      if (biometryAvailable() != "biometric") {
        promise.reject(E_NOT_AVAILABLE, "biometrics not available")
        return
      }
      val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key(BIO_ALIAS, true)) }
      authenticate(cipher, prompt, promise) { authorized ->
        save(key, authorized, value, biometric = true)
        promise.resolve(null)
      }
    } catch (e: KeyPermanentlyInvalidatedException) {
      deleteKey(BIO_ALIAS)
      promise.reject(E_INVALIDATED, "biometric key invalidated", e)
    } catch (e: Exception) {
      promise.reject(E_KEYSTORE, e.message, e)
    }
  }

  override fun getItem(key: String, prompt: String, promise: Promise) {
    val stored = prefs.getString(key, null)
    if (stored == null) {
      promise.resolve(null)
      return
    }
    try {
      val biometric = prefs.getBoolean(BIO_PREFIX + key, false)
      val (iv, ciphertext) = stored.split(":").map { Base64.decode(it, Base64.NO_WRAP) }
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key(if (biometric) BIO_ALIAS else PLAIN_ALIAS, biometric), GCMParameterSpec(128, iv))
      if (!biometric) {
        promise.resolve(String(cipher.doFinal(ciphertext), Charsets.UTF_8))
        return
      }
      authenticate(cipher, prompt, promise) { authorized ->
        promise.resolve(String(authorized.doFinal(ciphertext), Charsets.UTF_8))
      }
    } catch (e: KeyPermanentlyInvalidatedException) {
      // 생체 정보가 바뀌었다 → 이 값은 다시 열 수 없다
      deleteKey(BIO_ALIAS)
      prefs.edit().remove(key).remove(BIO_PREFIX + key).apply()
      promise.reject(E_INVALIDATED, "biometric key invalidated", e)
    } catch (e: Exception) {
      promise.reject(E_KEYSTORE, e.message, e)
    }
  }

  override fun removeItem(key: String, promise: Promise) {
    prefs.edit().remove(key).remove(BIO_PREFIX + key).apply()
    promise.resolve(null)
  }

  override fun biometryType(promise: Promise) {
    promise.resolve(biometryAvailable())
  }

  private fun biometryAvailable(): String =
      if (BiometricManager.from(context).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS)
          "biometric"
      else "none"

  private fun save(key: String, cipher: Cipher, value: String, biometric: Boolean) {
    val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    val encoded = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ciphertext, Base64.NO_WRAP)
    // commit(): 앱이 바로 종료돼도 저장이 끝난 뒤에 성공을 알린다
    prefs.edit().putString(key, encoded).putBoolean(BIO_PREFIX + key, biometric).commit()
  }

  private fun authenticate(cipher: Cipher, prompt: String, promise: Promise, onSuccess: (Cipher) -> Unit) {
    val activity = reactApplicationContext.getCurrentActivity() as? FragmentActivity
    if (activity == null) {
      promise.reject(E_NOT_AVAILABLE, "no foreground activity")
      return
    }
    activity.runOnUiThread {
      val callback =
          object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
              val authorized = result.cryptoObject?.cipher
              if (authorized == null) {
                promise.reject(E_KEYSTORE, "missing cipher")
                return
              }
              try {
                onSuccess(authorized)
              } catch (e: Exception) {
                promise.reject(E_KEYSTORE, e.message, e)
              }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
              val code =
                  when (errorCode) {
                    BiometricPrompt.ERROR_USER_CANCELED,
                    BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                    BiometricPrompt.ERROR_CANCELED -> E_CANCELLED
                    BiometricPrompt.ERROR_LOCKOUT,
                    BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> E_LOCKOUT
                    else -> E_AUTH_FAILED
                  }
              promise.reject(code, errString.toString())
            }
          }
      val info =
          BiometricPrompt.PromptInfo.Builder()
              .setTitle(prompt.ifBlank { "본인 확인" })
              .setNegativeButtonText("취소")
              .setAllowedAuthenticators(BIOMETRIC_STRONG)
              .build()
      BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
          .authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
  }

  private fun key(alias: String, requireAuth: Boolean): SecretKey {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    (keyStore.getKey(alias, null) as? SecretKey)?.let {
      return it
    }
    val spec =
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .apply {
              if (requireAuth) {
                setUserAuthenticationRequired(true)
                setInvalidatedByBiometricEnrollment(true)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                  // 매번 생체 인증(시간 창 0초)
                  setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                }
              }
            }
            .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).run {
      init(spec)
      generateKey()
    }
  }

  private fun deleteKey(alias: String) {
    KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }.deleteEntry(alias)
  }

  companion object {
    const val NAME = NativeSecureStoreSpec.NAME
    private const val PREFS = "hoga_secure_store"
    private const val BIO_PREFIX = "__bio__:"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val PLAIN_ALIAS = "hoga.store.device"
    private const val BIO_ALIAS = "hoga.store.biometric"

    const val E_CANCELLED = "E_CANCELLED"
    const val E_NOT_AVAILABLE = "E_NOT_AVAILABLE"
    const val E_INVALIDATED = "E_INVALIDATED"
    const val E_LOCKOUT = "E_LOCKOUT"
    const val E_AUTH_FAILED = "E_AUTH_FAILED"
    const val E_KEYSTORE = "E_KEYSTORE"
  }
}
