/**
 * 웹 화면 번역 · 숫자 형식. 앱과 같은 번역 파일(shared/i18n)을 /i18n/:lang 으로 받아 쓴다.
 */
(function (global) {
  'use strict';

  var SUPPORTED = ['ko', 'en', 'id', 'th'];
  var state = { lang: 'ko', messages: {}, listeners: [] };

  function normalize(lang) {
    var short = String(lang || '').slice(0, 2).toLowerCase();
    return SUPPORTED.indexOf(short) >= 0 ? short : 'ko';
  }

  function fromQuery() {
    var match = /[?&]lang=([a-z]{2})/.exec(global.location.search);
    return match ? match[1] : null;
  }

  function t(key, params) {
    var text = Object.prototype.hasOwnProperty.call(state.messages, key) ? state.messages[key] : key;
    return text.replace(/\{(\w+)\}/g, function (all, name) {
      return params && params[name] !== undefined ? String(params[name]) : all;
    });
  }

  function number(n, options) {
    return new Intl.NumberFormat(state.lang, options).format(n);
  }

  function load(lang) {
    var next = normalize(lang);
    return fetch('/i18n/' + next)
      .then(function (r) {
        if (!r.ok) throw new Error('i18n ' + r.status);
        return r.json();
      })
      .then(function (body) {
        state.lang = next;
        state.messages = body.messages || {};
        document.documentElement.lang = next;
        state.listeners.forEach(function (fn) {
          fn(next);
        });
        return next;
      });
  }

  global.HogaI18n = Object.freeze({
    initial: function () {
      return normalize(fromQuery() || global.navigator.language);
    },
    load: load,
    t: t,
    number: number,
    lang: function () {
      return state.lang;
    },
    onChange: function (fn) {
      state.listeners.push(fn);
    },
  });
})(window);
