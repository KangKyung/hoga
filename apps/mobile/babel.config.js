/**
 * HOGA_DEV_SERVER_HOST: CI(E2E)가 개발 서버와 다른 포트의 전용 서버를 띄울 때 그 주소를 번들에 넣는다.
 * 비어 있으면 아무것도 바꾸지 않는다(src/config.ts의 기본값 localhost:8080).
 * 변환 캐시가 개발용 Metro와 섞이지 않도록 metro.config.js의 cacheVersion에도 같은 값을 넣는다.
 */
function inlineDevServerHost({types: t}) {
  const host = process.env.HOGA_DEV_SERVER_HOST;
  return {
    name: 'inline-hoga-dev-server-host',
    visitor: {
      MemberExpression(p) {
        if (host && p.matchesPattern('process.env.HOGA_DEV_SERVER_HOST')) p.replaceWith(t.stringLiteral(host));
      },
    },
  };
}

module.exports = api => {
  api.cache.using(() => process.env.HOGA_DEV_SERVER_HOST ?? '');
  return {
    presets: ['module:@react-native/babel-preset'],
    plugins: [inlineDevServerHost],
  };
};
