package com.hogaapp.capture

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.FileProvider
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.hogaapp.specs.NativeDocumentCaptureSpec
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * 신분증 촬영(비대면 계좌 개설, Android · Kotlin).
 *
 * - 카메라: 기본 카메라 앱(ACTION_IMAGE_CAPTURE)에 앱 캐시의 임시 파일을 FileProvider로 넘긴다.
 *   CAMERA 권한을 선언하지 않는다(카메라 앱이 찍는다).
 * - 앨범: Android 13+ 사진 선택기(권한 불필요), 그 아래는 ACTION_GET_CONTENT.
 * - 결과: EXIF 방향대로 세우고 긴 변을 줄여 JPEG로 다시 인코딩(메타데이터가 빠진다). 임시 파일은 바로 지운다.
 * - 카메라 앱을 띄운 사이 앱 프로세스가 죽으면 결과 콜백이 오지 않아 임시 파일(원본 사진·EXIF)이 남는다.
 *   그래서 모듈이 만들어질 때(새 프로세스) 이전 임시 파일을 모두 지우고, 모듈이 내려갈 때 진행 중인 파일을 지운다.
 */
class DocumentCaptureModule(private val context: ReactApplicationContext) :
    NativeDocumentCaptureSpec(context), ActivityEventListener {

  private var pending: Pending? = null
  private val worker = Executors.newSingleThreadExecutor()

  private data class Pending(
      val promise: Promise,
      val maxDimension: Int,
      val quality: Int,
      val cameraFile: File?,
  )

  init {
    context.addActivityEventListener(this)
    // 새 프로세스(이전 프로세스가 촬영 중 죽었을 수 있다)에서 한 번. 아직 촬영 전이라 지워도 안전하다
    clearTempFiles()
  }

  private fun tempDir() = File(context.cacheDir, "idcard")

  private fun clearTempFiles() {
    tempDir().listFiles()?.forEach { it.delete() }
  }

  override fun getName() = NAME

  override fun isCameraAvailable(): Boolean =
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

  override fun capture(source: String, maxDimension: Double, quality: Double, promise: Promise) {
    val activity = context.currentActivity
    if (activity == null) return promise.reject("E_NO_SCREEN", "no activity")
    if (pending != null) return promise.reject("E_BUSY", "capture in progress")
    val dim = maxDimension.roundToInt().coerceIn(320, 4096)
    val q = (quality * 100).roundToInt().coerceIn(30, 95)

    var file: File? = null
    try {
      if (source == "camera") {
        if (!isCameraAvailable()) return promise.reject("E_NO_CAMERA", "no camera")
        val dir = tempDir().apply { mkdirs() }
        file = File.createTempFile("capture", ".jpg", dir)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.idcapture", file)
        val intent =
            Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        pending = Pending(promise, dim, q, file)
        activity.startActivityForResult(intent, REQUEST_CODE)
      } else {
        val intent =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
              Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*")
            } else {
              Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE)
            }
        pending = Pending(promise, dim, q, null)
        activity.startActivityForResult(intent, REQUEST_CODE)
      }
    } catch (e: ActivityNotFoundException) {
      pending = null
      file?.delete()
      promise.reject("E_NO_APP", e.message, e)
    } catch (e: Exception) {
      // SecurityException(카메라 앱 정책), IOException(임시 파일) 등: pending을 남기면 이후 촬영이 계속 E_BUSY가 된다
      pending = null
      file?.delete()
      promise.reject("E_CAPTURE", e.message, e)
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST_CODE) return
    val p = pending ?: return
    pending = null
    if (resultCode != Activity.RESULT_OK) {
      p.cameraFile?.delete()
      return p.promise.reject("E_CANCELLED", "cancelled")
    }
    val uri = p.cameraFile?.let { Uri.fromFile(it) } ?: data?.data
    if (uri == null) return p.promise.reject("E_NO_IMAGE", "no image")
    worker.execute {
      try {
        p.promise.resolve(process(uri, p.maxDimension, p.quality))
      } catch (e: Exception) {
        p.promise.reject("E_ENCODE", e.message, e)
      } finally {
        p.cameraFile?.delete()
      }
    }
  }

  override fun onNewIntent(intent: Intent) {}

  override fun invalidate() {
    context.removeActivityEventListener(this)
    pending?.cameraFile?.delete()
    pending = null
    worker.shutdown()
    super.invalidate()
  }

  private fun process(uri: Uri, maxDimension: Int, quality: Int): com.facebook.react.bridge.WritableMap {
    val resolver = context.contentResolver
    // 1) 크기만 읽어 2의 거듭제곱으로 줄여 디코딩(메모리 절약)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxDimension) sample *= 2
    val decoded =
        resolver.openInputStream(uri).use {
          BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: throw IllegalStateException("decode failed")

    // 2) EXIF 방향대로 세우고 정확한 크기로
    val orientation =
        resolver.openInputStream(uri).use {
          if (it == null) ExifInterface.ORIENTATION_NORMAL
          else ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        }
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
    }
    val scale = minOf(1f, maxDimension.toFloat() / max(decoded.width, decoded.height))
    matrix.postScale(scale, scale)
    val bitmap = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
    if (bitmap !== decoded) decoded.recycle()

    // 3) JPEG로 다시 인코딩 → 원본 EXIF(위치 등)는 따라오지 않는다
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
    val bytes = out.toByteArray()
    return Arguments.createMap().apply {
      putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      putInt("width", bitmap.width)
      putInt("height", bitmap.height)
      putInt("bytes", bytes.size)
    }.also { bitmap.recycle() }
  }

  companion object {
    const val NAME = "NativeDocumentCapture"
    private const val REQUEST_CODE = 41_207
  }
}
