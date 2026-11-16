// 신분증 촬영 TurboModule(iOS) 연결부. 실제 화면·이미지 처리는 Swift(DocumentCapture.swift).
// TurboModule은 Objective-C++ 클래스여야 해서(C++ JSI 객체를 돌려줌) 얇은 연결부만 여기에 둔다.
#import <AppSpecs/AppSpecs.h>
// 생성된 Swift 헤더가 앱의 다른 Swift 클래스(SceneDelegate)의 상위 클래스도 선언하므로 먼저 가져온다
#import <React_RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>

#import "HogaApp-Swift.h"

@interface HogaDocumentCapture : NativeDocumentCaptureSpecBase <NativeDocumentCaptureSpec>
@end

@implementation HogaDocumentCapture

+ (NSString *)moduleName
{
  return @"NativeDocumentCapture";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeDocumentCaptureSpecJSI>(params);
}

- (NSNumber *)isCameraAvailable
{
  return @([HogaDocumentCaptureController isCameraAvailable]);
}

- (void)capture:(NSString *)source
    maxDimension:(double)maxDimension
         quality:(double)quality
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  [HogaDocumentCaptureController captureWithSource:source
                                      maxDimension:maxDimension
                                           quality:quality
                                        completion:^(NSDictionary *result, NSString *error) {
                                          if (error != nil) {
                                            reject(error, error, nil);
                                          } else {
                                            resolve(result);
                                          }
                                        }];
}

@end
