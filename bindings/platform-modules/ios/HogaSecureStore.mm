// 보안 저장소(iOS, Objective-C). Keychain에 값을 저장한다.
//
// - 일반 값: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
//   (재부팅 후 첫 잠금 해제 전에는 못 읽고, 백업·기기 이전으로 복제되지 않음)
// - 생체 보호 값: SecAccessControl(.biometryCurrentSet) + kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
//   읽을 때마다 Face ID/Touch ID. 생체 정보가 바뀌면 값이 무효화된다(→ 다시 로그인).
// - Keychain 호출은 생체 인증 동안 블록되므로 전용 직렬 큐에서 실행한다.
// - Keychain은 앱을 지워도 남는다(Android Keystore·SharedPreferences는 함께 지워짐). 그대로 두면 다시 설치했을 때
//   리프레시 토큰으로 이전 계정에 자동 로그인된다. 그래서 설치 뒤 첫 실행(앱과 함께 지워지는 UserDefaults에 표시가
//   없음)이면 이 앱의 항목을 모두 지운다. 같은 직렬 큐의 첫 작업이라 어떤 읽기보다 먼저 끝난다.
#import <AppSpecs/AppSpecs.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>

static NSString *const kService = @"com.hogaapp.secure";
static NSString *const kBiometricService = @"com.hogaapp.secure.biometric";
static NSString *const kInstalledFlag = @"com.hogaapp.secure.installed";

@interface HogaSecureStore : NativeSecureStoreSpecBase <NativeSecureStoreSpec>
@end

@implementation HogaSecureStore {
  dispatch_queue_t _queue;
}

+ (NSString *)moduleName
{
  return @"NativeSecureStore";
}

- (instancetype)init
{
  if (self = [super init]) {
    _queue = dispatch_queue_create("com.hogaapp.securestore", DISPATCH_QUEUE_SERIAL);
    dispatch_async(_queue, ^{
      NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
      if ([defaults boolForKey:kInstalledFlag]) return;
      for (NSString *service in @[ kService, kBiometricService ]) {
        NSDictionary *all = @{
          (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
          (__bridge id)kSecAttrService : service,
        };
        SecItemDelete((__bridge CFDictionaryRef)all);
      }
      [defaults setBool:YES forKey:kInstalledFlag];
    });
  }
  return self;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeSecureStoreSpecJSI>(params);
}

static NSMutableDictionary *BaseQuery(NSString *service, NSString *key)
{
  return [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : service,
    (__bridge id)kSecAttrAccount : key,
  } mutableCopy];
}

static void Reject(RCTPromiseRejectBlock reject, OSStatus status)
{
  NSString *code = @"E_KEYCHAIN";
  if (status == errSecUserCanceled) code = @"E_CANCELLED";
  else if (status == errSecAuthFailed) code = @"E_AUTH_FAILED";
  else if (status == errSecNotAvailable || status == errSecInteractionNotAllowed) code = @"E_NOT_AVAILABLE";
  reject(code, [NSString stringWithFormat:@"Keychain error %d", (int)status], nil);
}

- (void)setItem:(NSString *)key
                value:(NSString *)value
    requireBiometrics:(BOOL)requireBiometrics
               prompt:(NSString *)prompt
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(_queue, ^{
    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
    // 같은 키가 다른 보호 수준으로 남아 있지 않게 양쪽에서 지운 뒤 저장한다.
    SecItemDelete((__bridge CFDictionaryRef)BaseQuery(requireBiometrics ? kService : kBiometricService, key));

    if (!requireBiometrics) {
      NSDictionary *update = @{(__bridge id)kSecValueData : data};
      OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)BaseQuery(kService, key), (__bridge CFDictionaryRef)update);
      if (status == errSecItemNotFound) {
        // 삭제 후 재삽입이 아니라 갱신 우선: 중간에 앱이 죽어도 이전 값이 남는다.
        NSMutableDictionary *add = BaseQuery(kService, key);
        add[(__bridge id)kSecValueData] = data;
        add[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
        status = SecItemAdd((__bridge CFDictionaryRef)add, NULL);
      }
      status == errSecSuccess ? resolve(nil) : Reject(reject, status);
      return;
    }

    CFErrorRef error = NULL;
    SecAccessControlRef access = SecAccessControlCreateWithFlags(
        NULL, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, kSecAccessControlBiometryCurrentSet, &error);
    if (!access) {
      if (error) CFRelease(error);
      reject(@"E_NOT_AVAILABLE", @"biometrics not available", nil);
      return;
    }
    // ACL은 갱신할 수 없으므로 생체 보호 값은 지우고 새로 넣는다.
    SecItemDelete((__bridge CFDictionaryRef)BaseQuery(kBiometricService, key));
    NSMutableDictionary *add = BaseQuery(kBiometricService, key);
    add[(__bridge id)kSecValueData] = data;
    add[(__bridge id)kSecAttrAccessControl] = (__bridge_transfer id)access;
    OSStatus status = SecItemAdd((__bridge CFDictionaryRef)add, NULL);
    status == errSecSuccess ? resolve(nil) : Reject(reject, status);
  });
}

- (void)getItem:(NSString *)key
         prompt:(NSString *)prompt
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(_queue, ^{
    for (NSString *service in @[ kService, kBiometricService ]) {
      NSMutableDictionary *query = BaseQuery(service, key);
      query[(__bridge id)kSecReturnData] = @YES;
      query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
      if ([service isEqualToString:kBiometricService]) {
        LAContext *context = [LAContext new];
        context.localizedReason = prompt.length > 0 ? prompt : @"본인 확인";
        context.localizedCancelTitle = @"취소";
        query[(__bridge id)kSecUseAuthenticationContext] = context;
      }
      CFTypeRef result = NULL;
      OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
      if (status == errSecItemNotFound) continue;
      if (status != errSecSuccess) {
        Reject(reject, status);
        return;
      }
      NSData *data = (__bridge_transfer NSData *)result;
      resolve([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
      return;
    }
    resolve([NSNull null]);
  });
}

- (void)removeItem:(NSString *)key resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(_queue, ^{
    SecItemDelete((__bridge CFDictionaryRef)BaseQuery(kService, key));
    SecItemDelete((__bridge CFDictionaryRef)BaseQuery(kBiometricService, key));
    resolve(nil);
  });
}

- (void)biometryType:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  LAContext *context = [LAContext new];
  NSError *error = nil;
  if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:&error]) {
    resolve(@"none");
    return;
  }
  switch (context.biometryType) {
    case LABiometryTypeFaceID:
      resolve(@"faceId");
      break;
    case LABiometryTypeTouchID:
      resolve(@"touchId");
      break;
    case LABiometryTypeOpticID:
      resolve(@"opticId");
      break;
    default:
      resolve(@"none");
  }
}

@end
