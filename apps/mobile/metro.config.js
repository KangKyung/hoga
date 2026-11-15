const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * shared/: 앱과 서버(웹 화면)가 함께 쓰는 번역·분석 이벤트 정의. 저장소 루트에 있어 감시 폴더에 더한다.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [path.resolve(__dirname, '../../shared')],
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
