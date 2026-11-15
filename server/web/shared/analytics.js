/**
 * 웹 분석. 이벤트 이름·매개변수는 앱과 같은 분류표(shared/analytics/events.json)를 따른다.
 *
 * - 앱 웹뷰 안: 이벤트를 브리지로 앱에 넘겨 앱의 분석 파이프라인 하나로만 보낸다(이중 집계 방지).
 * - 일반 브라우저: dataLayer에 쌓고, GTM 컨테이너 ID가 설정돼 있으면 GTM을 불러 GA4로 보낸다.
 * - 분류표에 없는 이벤트·매개변수는 개발 중에 바로 보이도록 콘솔 경고를 남긴다.
 */
(function (global) {
  'use strict';

  var config = global.HOGA_WEB_CONFIG || {};
  var taxonomy = null;
  global.dataLayer = global.dataLayer || [];

  fetch('/shared/analytics/events.json')
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (body) {
      taxonomy = body && body.events;
    })
    .catch(function () {});

  function check(name, params) {
    if (!taxonomy || !global.console) return;
    var spec = taxonomy[name];
    if (!spec) return global.console.warn('[analytics] 분류표에 없는 이벤트:', name);
    if (spec.source.indexOf('web') < 0) global.console.warn('[analytics] 웹에서 보내지 않는 이벤트:', name);
    Object.keys(params || {}).forEach(function (key) {
      if (!(key in spec.params)) global.console.warn('[analytics] 분류표에 없는 매개변수:', name, key);
    });
  }

  function track(name, params) {
    params = params || {};
    check(name, params);
    if (global.HogaBridge && global.HogaBridge.send('track', { name: name, params: params })) return;
    var entry = { event: name };
    Object.keys(params).forEach(function (k) {
      entry[k] = params[k];
    });
    global.dataLayer.push(entry);
  }

  function loadGtm(id) {
    if (!id || (global.HogaBridge && global.HogaBridge.inApp())) return;
    global.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id);
    document.head.appendChild(script);
  }

  loadGtm(config.gtmContainerId);
  global.HogaAnalytics = Object.freeze({ track: track });
})(window);
