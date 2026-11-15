// iOS에서 C++ TurboModule을 등록하는 Objective-C++ 제공자.
// apps/mobile/package.json의 codegenConfig.ios.modulesProvider가 이 클래스 이름을 가리킨다.
#import <Foundation/Foundation.h>
#import <ReactCommon/RCTTurboModule.h>

#import "NativeHogaCore.h"

@interface HogaCoreModuleProvider : NSObject <RCTModuleProvider>
@end

@implementation HogaCoreModuleProvider

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeHogaCore>(params.jsInvoker);
}

@end
