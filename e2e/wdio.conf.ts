/**
 * Appium + WebdriverIO 설정 하나로 iOS·Android를 모두 돌린다.
 * PLATFORM=ios|android 로 capability만 바꾸고, 테스트 코드는 한 벌이다(요소는 RN testID로 찾는다).
 *
 * 필요한 것: 서버(localhost:8080), Metro(8081), 부팅된 시뮬레이터/에뮬레이터, Appium(4723).
 * 앱은 미리 빌드해 둔다. 경로는 IOS_APP / ANDROID_APK로 바꿀 수 있다.
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '../apps/mobile');
const platform = (process.env.PLATFORM ?? 'ios') as 'ios' | 'android';

const ios = {
  platformName: 'iOS',
  'appium:automationName': 'XCUITest',
  'appium:deviceName': process.env.IOS_DEVICE ?? 'iPhone 17 Pro',
  ...(process.env.IOS_UDID ? {'appium:udid': process.env.IOS_UDID} : {}),
  'appium:app': process.env.IOS_APP ?? path.join(mobile, 'ios/build/dd/Build/Products/Debug-iphonesimulator/HogaApp.app'),
  'appium:bundleId': 'org.reactjs.native.example.HogaApp',
  'appium:noReset': true,
  'appium:newCommandTimeout': 240,
  'appium:wdaLaunchTimeout': 240_000,
};

const android = {
  platformName: 'Android',
  'appium:automationName': 'UiAutomator2',
  'appium:deviceName': process.env.ANDROID_DEVICE ?? 'emulator-5554',
  'appium:app': process.env.ANDROID_APK ?? path.join(mobile, 'android/app/build/outputs/apk/debug/app-debug.apk'),
  'appium:appPackage': 'com.hogaapp',
  'appium:appActivity': '.MainActivity',
  'appium:noReset': true,
  'appium:newCommandTimeout': 240,
  'appium:uiautomator2ServerInstallTimeout': 120_000,
  'appium:adbExecTimeout': 60_000,
  // 호가 화면은 계속 갱신돼 "화면이 멈출 때까지 기다리기"가 끝나지 않는다 → 끄기
  'appium:waitForIdleTimeout': 0,
  'appium:disableWindowAnimation': true,
};

export const config: WebdriverIO.Config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: Number(process.env.APPIUM_PORT ?? 4723),
  specs: ['./specs/flows.e2e.ts'],
  maxInstances: 1,
  capabilities: [platform === 'ios' ? ios : android],
  logLevel: 'warn',
  waitforTimeout: 15_000,
  connectionRetryTimeout: 300_000,
  connectionRetryCount: 1,
  framework: 'mocha',
  mochaOpts: {ui: 'bdd', timeout: 180_000},
  reporters: [
    'spec',
    ['junit', {outputDir: path.join(here, 'reports', platform), outputFileFormat: () => `e2e-${platform}.xml`}],
  ],
  /** 실패하면 화면과 요소 트리(XML)를 남긴다. Android는 FLAG_SECURE라 화면이 검게 저장되므로 트리가 단서다 */
  afterTest: async (test, _context, {passed}) => {
    if (passed) return;
    const base = path.join(here, 'reports', platform, test.title.replace(/[^\w가-힣-]+/g, '_'));
    mkdirSync(path.dirname(base), {recursive: true});
    await browser.saveScreenshot(`${base}.png`).catch(() => {});
    await browser
      .getPageSource()
      .then(xml => writeFileSync(`${base}.xml`, xml))
      .catch(() => {});
  },
};
