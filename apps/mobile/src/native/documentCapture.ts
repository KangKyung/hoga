import NativeDocumentCapture from '../../specs/NativeDocumentCapture';

export interface CapturedImage {
  base64: string;
  width: number;
  height: number;
  bytes: number;
}

/** 서버 제한(1.5MB)보다 충분히 작게: 긴 변 1600px, JPEG 0.8 */
const MAX_DIMENSION = 1600;
const QUALITY = 0.8;

export const documentCapture = {
  isCameraAvailable: () => NativeDocumentCapture.isCameraAvailable(),
  /** 취소하면 null */
  async capture(source: 'camera' | 'library'): Promise<CapturedImage | null> {
    try {
      return (await NativeDocumentCapture.capture(source, MAX_DIMENSION, QUALITY)) as unknown as CapturedImage;
    } catch (e) {
      if ((e as {code?: string}).code === 'E_CANCELLED') return null;
      throw e;
    }
  },
};
