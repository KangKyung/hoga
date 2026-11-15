/**
 * 웹 ↔ 앱 브리지 (웹 쪽). 앱 쪽 구현: apps/mobile/src/web/bridge.ts
 *
 * 봉투: { v: 프로토콜 버전, type, payload }
 *   웹 → 앱: window.ReactNativeWebView.postMessage(JSON 문자열)
 *   앱 → 웹: 앱이 injectJavaScript로 HogaBridge.receive(JSON 문자열)을 호출
 *
 * 순서: 웹이 hello(protocol)를 보내면 앱이 init(언어·테마) 또는 unsupported로 답한다.
 * 앱 밖(일반 브라우저)에서 열면 send는 아무 일도 하지 않고 false를 돌려준다 → 화면은 혼자서도 동작해야 한다.
 */
(function (global) {
  'use strict';

  var PROTOCOL = 1;
  var handlers = {};
  var peer = null;

  function inApp() {
    return !!(global.ReactNativeWebView && typeof global.ReactNativeWebView.postMessage === 'function');
  }

  function send(type, payload) {
    if (!inApp()) return false;
    global.ReactNativeWebView.postMessage(JSON.stringify({ v: PROTOCOL, type: type, payload: payload || {} }));
    return true;
  }

  function on(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
    return function off() {
      handlers[type] = (handlers[type] || []).filter(function (h) {
        return h !== fn;
      });
    };
  }

  function receive(raw) {
    var msg;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      return;
    }
    if (!msg || msg.v !== PROTOCOL || typeof msg.type !== 'string') return;
    if (msg.type === 'init') peer = msg.payload || {};
    (handlers[msg.type] || []).forEach(function (fn) {
      try {
        fn(msg.payload || {});
      } catch (e) {
        if (global.console) global.console.error(e);
      }
    });
  }

  global.HogaBridge = Object.freeze({
    PROTOCOL: PROTOCOL,
    inApp: inApp,
    send: send,
    on: on,
    receive: receive,
    peer: function () {
      return peer;
    },
    hello: function (page) {
      return send('hello', { page: page, protocol: PROTOCOL });
    },
  });
})(window);
