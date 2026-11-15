// 기기 보안 신호(iOS, Objective-C).
// 탈옥·디버거 감지는 쉽게 우회되는 참고 신호다. 앱에서 막지 않고 서버가 판단하는 것을 전제로 한다.
#import <AppSpecs/AppSpecs.h>
#import <UIKit/UIKit.h>
#import <mach-o/dyld.h>
#import <sys/sysctl.h>
#import <unistd.h>

#include <atomic>

@interface HogaDeviceGuard : NativeDeviceGuardSpecBase <NativeDeviceGuardSpec>
@end

@implementation HogaDeviceGuard {
  std::atomic<bool> _captured;
  BOOL _secureScreen;
  UIView *_shield;
}

+ (NSString *)moduleName
{
  return @"NativeDeviceGuard";
}

- (instancetype)init
{
  if (self = [super init]) {
    _captured = false;
    dispatch_async(dispatch_get_main_queue(), ^{
      [self refreshCaptured];
      NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
      [center addObserver:self
                 selector:@selector(refreshCaptured)
                     name:UIScreenCapturedDidChangeNotification
                   object:nil];
      [center addObserver:self
                 selector:@selector(willResignActive)
                     name:UIApplicationWillResignActiveNotification
                   object:nil];
      [center addObserver:self
                 selector:@selector(didBecomeActive)
                     name:UIApplicationDidBecomeActiveNotification
                   object:nil];
    });
  }
  return self;
}

- (void)dealloc
{
  [NSNotificationCenter.defaultCenter removeObserver:self];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeDeviceGuardSpecJSI>(params);
}

// UI 상태는 메인 스레드에서만 읽고, JS 스레드는 캐시된 값을 본다.
- (void)refreshCaptured
{
  BOOL captured = NO;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    if (@available(iOS 17.0, *)) {
      captured = captured ||
          ((UIWindowScene *)scene).traitCollection.sceneCaptureState == UISceneCaptureStateActive;
    }
  }
  _captured = captured;
}

static BOOL DebuggerAttached(void)
{
  struct kinfo_proc info = {};
  size_t size = sizeof(info);
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
  if (sysctl(mib, 4, &info, &size, NULL, 0) != 0) return NO;
  return (info.kp_proc.p_flag & P_TRACED) != 0;
}

static NSArray<NSString *> *JailbreakReasons(void)
{
  NSMutableArray *reasons = [NSMutableArray array];
#if !TARGET_OS_SIMULATOR
  // 시뮬레이터는 Mac 파일 시스템을 보므로 경로 검사가 의미 없다.
  for (NSString *path in @[
         @"/Applications/Cydia.app", @"/Applications/Sileo.app", @"/Library/MobileSubstrate/MobileSubstrate.dylib",
         @"/usr/sbin/sshd", @"/etc/apt", @"/private/var/lib/apt", @"/var/jb"
       ]) {
    if ([NSFileManager.defaultManager fileExistsAtPath:path]) {
      [reasons addObject:[@"path:" stringByAppendingString:path]];
      break;
    }
  }
  // 샌드박스 밖에 쓸 수 있으면 탈옥
  NSString *probe = @"/private/hoga_jb_probe.txt";
  if ([@"x" writeToFile:probe atomically:NO encoding:NSUTF8StringEncoding error:nil]) {
    [NSFileManager.defaultManager removeItemAtPath:probe error:nil];
    [reasons addObject:@"sandbox-write"];
  }
#endif
  // 후킹 라이브러리 로드 여부
  for (uint32_t i = 0; i < _dyld_image_count(); i++) {
    const char *name = _dyld_get_image_name(i);
    if (!name) continue;
    NSString *image = [NSString stringWithUTF8String:name].lowercaseString;
    for (NSString *needle in @[ @"substrate", @"frida", @"libhooker", @"cycript" ]) {
      if ([image containsString:needle]) {
        [reasons addObject:[@"dylib:" stringByAppendingString:needle]];
        return reasons;
      }
    }
  }
  return reasons;
}

- (NSDictionary *)getStatus
{
  NSArray *reasons = JailbreakReasons();
  return @{
    @"compromised" : @(reasons.count > 0),
    @"reasons" : reasons,
#if TARGET_OS_SIMULATOR
    @"emulator" : @YES,
#else
    @"emulator" : @NO,
#endif
    @"debugger" : @(DebuggerAttached()),
    @"captured" : @(_captured.load()),
  };
}

// iOS는 화면 캡처 자체를 막을 수 없다. 대신 앱 전환기 미리보기에 잔고·호가가 보이지 않게 가린다.
- (void)setSecureScreen:(BOOL)enabled
{
  dispatch_async(dispatch_get_main_queue(), ^{
    self->_secureScreen = enabled;
    if (!enabled) [self removeShield];
  });
}

- (void)willResignActive
{
  if (!_secureScreen || _shield) return;
  UIWindow *window = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if ([scene isKindOfClass:UIWindowScene.class]) {
      window = ((UIWindowScene *)scene).keyWindow;
      if (window) break;
    }
  }
  if (!window) return;
  UIVisualEffectView *shield =
      [[UIVisualEffectView alloc] initWithEffect:[UIBlurEffect effectWithStyle:UIBlurEffectStyleSystemMaterial]];
  shield.frame = window.bounds;
  shield.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [window addSubview:shield];
  _shield = shield;
}

- (void)didBecomeActive
{
  [self removeShield];
}

- (void)removeShield
{
  [_shield removeFromSuperview];
  _shield = nil;
}

@end
