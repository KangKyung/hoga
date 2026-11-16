import PhotosUI
import UIKit

/// 신분증 촬영·선택(비대면 계좌 개설). TurboModule 연결부(HogaDocumentCapture.mm)가 부른다.
///
/// - 카메라: UIImagePickerController(.camera). 앨범: PHPickerViewController(사진 접근 권한이 필요 없다).
/// - 결과 이미지는 긴 변을 maxDimension 이하로 줄이고 JPEG로 다시 인코딩한다.
///   UIImage로 다시 그리면 위치 정보 같은 EXIF가 빠진다(개인정보 최소화).
/// - 한 번에 하나만. 진행 중에 또 부르면 E_BUSY.
@objc(HogaDocumentCaptureController)
public final class DocumentCaptureController: NSObject {
  public typealias Completion = (NSDictionary?, String?) -> Void

  private static var current: DocumentCaptureController?

  private let maxDimension: CGFloat
  private let quality: CGFloat
  private var completion: Completion?

  private init(maxDimension: CGFloat, quality: CGFloat, completion: @escaping Completion) {
    self.maxDimension = maxDimension
    self.quality = quality
    self.completion = completion
  }

  @objc public static func isCameraAvailable() -> Bool {
    UIImagePickerController.isSourceTypeAvailable(.camera)
  }

  @objc public static func capture(
    source: String, maxDimension: Double, quality: Double, completion: @escaping Completion
  ) {
    DispatchQueue.main.async {
      guard current == nil else { return completion(nil, "E_BUSY") }
      guard let presenter = topViewController() else { return completion(nil, "E_NO_SCREEN") }
      let controller = DocumentCaptureController(
        maxDimension: CGFloat(min(max(maxDimension, 320), 4096)),
        quality: CGFloat(min(max(quality, 0.3), 0.95)),
        completion: completion)
      current = controller

      if source == "camera" {
        guard isCameraAvailable() else { return controller.finish(nil, "E_NO_CAMERA") }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = controller
        presenter.present(picker, animated: true)
      } else {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = controller
        presenter.present(picker, animated: true)
      }
    }
  }

  private func finish(_ result: NSDictionary?, _ error: String?) {
    let done = completion
    completion = nil
    DocumentCaptureController.current = nil
    done?(result, error)
  }

  /// 줄이고 JPEG로. 무거운 일이라 메인 스레드 밖에서
  private func process(_ image: UIImage) {
    DispatchQueue.global(qos: .userInitiated).async {
      let size = image.size
      let scale = min(1, self.maxDimension / max(size.width, size.height))
      let target = CGSize(width: floor(size.width * scale), height: floor(size.height * scale))
      let format = UIGraphicsImageRendererFormat.default()
      format.scale = 1
      // draw(in:)가 방향(imageOrientation)을 반영해 똑바로 세운다
      let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
        image.draw(in: CGRect(origin: .zero, size: target))
      }
      guard let data = resized.jpegData(compressionQuality: self.quality) else {
        return DispatchQueue.main.async { self.finish(nil, "E_ENCODE") }
      }
      let result: NSDictionary = [
        "base64": data.base64EncodedString(),
        "width": Int(target.width),
        "height": Int(target.height),
        "bytes": data.count,
      ]
      DispatchQueue.main.async { self.finish(result, nil) }
    }
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}

extension DocumentCaptureController: UIImagePickerControllerDelegate, UINavigationControllerDelegate {
  public func imagePickerController(
    _ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
  ) {
    let image = info[.originalImage] as? UIImage
    picker.dismiss(animated: true) {
      if let image { self.process(image) } else { self.finish(nil, "E_NO_IMAGE") }
    }
  }

  public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    picker.dismiss(animated: true) { self.finish(nil, "E_CANCELLED") }
  }
}

extension DocumentCaptureController: PHPickerViewControllerDelegate {
  public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true) {
      guard let provider = results.first?.itemProvider, provider.canLoadObject(ofClass: UIImage.self) else {
        return self.finish(nil, "E_CANCELLED")
      }
      provider.loadObject(ofClass: UIImage.self) { object, _ in
        guard let image = object as? UIImage else {
          return DispatchQueue.main.async { self.finish(nil, "E_NO_IMAGE") }
        }
        self.process(image)
      }
    }
  }
}
