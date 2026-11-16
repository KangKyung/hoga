import type {CodegenTypes, TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * 신분증 촬영(비대면 계좌 개설).
 * - iOS: Swift(UIImagePickerController 카메라 · PHPicker 앨범) + Objective-C++ TurboModule 연결부
 * - Android: Kotlin(카메라 앱 + FileProvider · 사진 선택기)
 *
 * 이미지는 네이티브에서 줄이고(긴 변 maxDimension) JPEG로 다시 인코딩한다 → 위치 등 EXIF 메타데이터가 빠진다.
 * 결과는 JS가 바로 서버로 올리고 웹 화면에는 결과만 알려 준다(이미지가 웹뷰·브리지를 지나지 않는다).
 */
export interface Spec extends TurboModule {
  /** 카메라가 있는 기기인가(시뮬레이터·에뮬레이터에 따라 없음) */
  isCameraAvailable(): boolean;
  /**
   * source: 'camera' | 'library'.
   * 성공: { base64, width, height, bytes }. 사용자가 닫으면 E_CANCELLED로 reject.
   */
  capture(source: string, maxDimension: number, quality: number): Promise<CodegenTypes.UnsafeObject>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeDocumentCapture');
