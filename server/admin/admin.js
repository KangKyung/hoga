/**
 * 관리 콘솔 — AngularJS 1.8.
 * 모의 거래소의 장애를 켜고 끄며, 앱이 어떻게 복구하는지 시연한다.
 */
(function (angular) {
  'use strict';

  var TOKEN_KEY = 'hoga.admin.token';
  var HISTORY = 120; // 2분(1초 간격)

  function storage(fn, fallback) {
    try {
      return fn(window.sessionStorage);
    } catch (e) {
      return fallback;
    }
  }

  angular
    .module('hogaAdmin', [])
    .config([
      '$compileProvider',
      function ($compileProvider) {
        $compileProvider.debugInfoEnabled(false);
      },
    ])

    // 모든 /admin/api 요청에 토큰 헤더를 붙이고, 401이면 토큰을 지운다
    .factory('adminAuth', [
      '$q',
      '$rootScope',
      function ($q, $rootScope) {
        var token = storage(function (s) {
          return s.getItem(TOKEN_KEY);
        }, null);
        return {
          get: function () {
            return token;
          },
          set: function (value) {
            token = value || null;
            storage(function (s) {
              if (token) s.setItem(TOKEN_KEY, token);
              else s.removeItem(TOKEN_KEY);
            });
          },
          request: function (config) {
            if (token && config.url.indexOf('/admin/api/') === 0) config.headers['x-admin-token'] = token;
            return config;
          },
          responseError: function (response) {
            if (response.status === 401) $rootScope.$broadcast('admin:unauthorized');
            return $q.reject(response);
          },
        };
      },
    ])
    .config([
      '$httpProvider',
      function ($httpProvider) {
        $httpProvider.interceptors.push('adminAuth');
      },
    ])

    .factory('adminApi', [
      '$http',
      function ($http) {
        var data = function (r) {
          return r.data;
        };
        return {
          state: function () {
            return $http.get('/admin/api/state').then(data);
          },
          faults: function (body) {
            return $http.put('/admin/api/faults', body).then(data);
          },
          volatility: function (body) {
            return $http.put('/admin/api/volatility', body).then(data);
          },
          session: function (phase) {
            return $http.put('/admin/api/session', { phase: phase }).then(data);
          },
          vi: function (symbol, action) {
            return $http.post('/admin/api/vi', { symbol: symbol, action: action }).then(data);
          },
          appConfig: function (body) {
            return $http.put('/admin/api/app-config', body).then(data);
          },
          disconnect: function () {
            return $http.post('/admin/api/disconnect', {}).then(data);
          },
        };
      },
    ])

    .controller('AdminController', [
      '$scope',
      '$interval',
      '$window',
      'adminApi',
      'adminAuth',
      function ($scope, $interval, $window, adminApi, adminAuth) {
        var vm = this;
        var prev = null;
        var rates = {};
        var history = [];
        var timer = null;

        vm.token = adminAuth.get();
        vm.tokenInput = '';
        vm.state = { counters: {}, symbols: [], faults: {} };
        vm.form = { dropSeqRate: 0, orderDelayMs: 0, simIntervalMs: 100, simBurst: 1 };
        vm.dirty = false;
        vm.busy = false;
        vm.connected = false;
        vm.error = null;
        vm.lastAction = null;
        vm.simOptions = [
          { value: 0, label: '멈춤' },
          { value: 10, label: '10 ms (부하 실험)' },
          { value: 20, label: '20 ms (매우 빠름)' },
          { value: 50, label: '50 ms' },
          { value: 100, label: '100 ms (기본)' },
          { value: 250, label: '250 ms' },
          { value: 1000, label: '1초' },
        ];
        vm.volOptions = [0.5, 1, 2, 5];

        function fail(prefix) {
          return function (response) {
            vm.error = prefix + ' (' + (response.status || '네트워크 오류') + ')';
          };
        }

        function poll() {
          adminApi.state().then(function (state) {
            if (prev) {
              var dt = Math.max(0.001, (state.ts - prev.ts) / 1000);
              Object.keys(state.counters).forEach(function (k) {
                rates[k] = Math.max(0, (state.counters[k] - prev.counters[k]) / dt);
              });
              history.push(rates.messagesSent || 0);
              if (history.length > HISTORY) history.shift();
            }
            prev = state;
            vm.state = state;
            vm.connected = true;
            vm.error = null;
            if (!vm.appDirty && state.appConfig) {
              vm.appForm = {
                minVersion: state.appConfig.minVersion,
                latestVersion: state.appConfig.latestVersion,
                maintenance: state.appConfig.maintenance.active,
                minutes: vm.appForm ? vm.appForm.minutes : 30,
              };
            }
            if (!vm.dirty) {
              vm.form = {
                dropSeqRate: state.faults.dropSeqRate,
                orderDelayMs: state.faults.orderDelayMs,
                simIntervalMs: state.faults.simIntervalMs,
                simBurst: state.faults.simBurst,
              };
            }
          }, function (response) {
            vm.connected = false;
            if (response.status !== 401) fail('상태를 읽지 못했습니다')(response);
          });
        }

        function start() {
          if (timer || !vm.token) return;
          poll();
          timer = $interval(poll, 1000);
        }

        function stop() {
          if (timer) $interval.cancel(timer);
          timer = null;
          prev = null;
          history = [];
        }

        vm.rate = function (key) {
          return rates[key] || 0;
        };

        vm.sparkPoints = function () {
          if (history.length < 2) return '';
          var max = Math.max.apply(null, history.concat(1));
          return history
            .map(function (v, i) {
              return ((i / (HISTORY - 1)) * 120).toFixed(1) + ',' + (38 - (v / max) * 36).toFixed(1);
            })
            .join(' ');
        };

        vm.changePct = function (s) {
          return s.basePrice ? ((s.lastPrice - s.basePrice) / s.basePrice) * 100 : 0;
        };
        vm.tone = function (s) {
          return s.lastPrice > s.basePrice ? 'up' : s.lastPrice < s.basePrice ? 'down' : 'flat';
        };

        vm.saveToken = function () {
          adminAuth.set(vm.tokenInput);
          vm.token = adminAuth.get();
          vm.tokenInput = '';
          start();
        };
        vm.logout = function () {
          adminAuth.set(null);
          vm.token = null;
          vm.connected = false;
          stop();
        };

        vm.applyFaults = function () {
          vm.busy = true;
          adminApi
            .faults({
              dropSeqRate: Number(vm.form.dropSeqRate),
              orderDelayMs: Number(vm.form.orderDelayMs),
              simIntervalMs: Number(vm.form.simIntervalMs),
              simBurst: Number(vm.form.simBurst),
            })
            .then(function (applied) {
              vm.dirty = false;
              vm.lastAction = '적용됨: 누락 ' + (applied.dropSeqRate * 100).toFixed(1) + '%, 주문 지연 ' + applied.orderDelayMs + 'ms, 주기 ' + applied.simIntervalMs + 'ms × ' + applied.simBurst;
            }, fail('적용하지 못했습니다'))
            .finally(function () {
              vm.busy = false;
            });
        };

        vm.resetFaults = function () {
          vm.form = { dropSeqRate: 0, orderDelayMs: 0, simIntervalMs: 100, simBurst: 1 };
          vm.dirty = true;
          vm.applyFaults();
        };

        vm.disconnect = function () {
          if (!$window.confirm('지금 연결된 모든 클라이언트를 끊을까요? 클라이언트는 자동으로 다시 접속합니다.')) return;
          vm.busy = true;
          adminApi
            .disconnect()
            .then(function (r) {
              vm.lastAction = '연결 ' + r.closed + '개를 끊었습니다';
            }, fail('끊지 못했습니다'))
            .finally(function () {
              vm.busy = false;
            });
        };

        vm.symbolLimit = 10;
        vm.phases = [
          { code: 'PRE_OPEN', label: '장 시작 동시호가' },
          { code: 'OPEN', label: '장중' },
          { code: 'CLOSING', label: '장 마감 동시호가' },
          { code: 'CLOSED', label: '장 종료' },
        ];
        vm.phaseLabel = function (code) {
          var found = vm.phases.filter(function (p) {
            return p.code === code;
          })[0];
          return found ? found.label : '-';
        };
        vm.secondsLeft = function (until) {
          return Math.max(0, Math.round((until - Date.now()) / 1000));
        };
        vm.viOf = function (code) {
          var list = (vm.state && vm.state.session && vm.state.session.vi) || [];
          return list.some(function (v) {
            return v.symbol === code;
          });
        };
        vm.setPhase = function (phase) {
          vm.busy = true;
          adminApi
            .session(phase)
            .then(function () {
              vm.lastAction = '장 구간: ' + vm.phaseLabel(phase);
            }, fail('장 구간을 바꾸지 못했습니다'))
            .finally(function () {
              vm.busy = false;
            });
        };
        vm.vi = function (s, action) {
          adminApi.vi(s.code, action).then(function () {
            vm.lastAction = s.name + ' VI ' + (action === 'trigger' ? '발동' : '해제');
          }, fail('VI를 바꾸지 못했습니다'));
        };
        vm.applyAppConfig = function () {
          var f = vm.appForm;
          vm.busy = true;
          adminApi
            .appConfig({
              minVersion: f.minVersion,
              latestVersion: f.latestVersion,
              maintenance: {
                active: Boolean(f.maintenance),
                until: f.maintenance ? Date.now() + Number(f.minutes || 30) * 60000 : null,
              },
            })
            .then(function () {
              vm.appDirty = false;
              vm.lastAction = '앱 설정 적용';
            }, fail('앱 설정을 바꾸지 못했습니다'))
            .finally(function () {
              vm.busy = false;
            });
        };

        vm.setVolatility = function (s) {
          adminApi.volatility({ symbol: s.code, multiplier: Number(s.volatility) }).then(function () {
            vm.lastAction = s.name + ' 변동성 × ' + s.volatility;
          }, fail('변동성을 바꾸지 못했습니다'));
        };

        $scope.$on('admin:unauthorized', function () {
          vm.error = '토큰이 맞지 않습니다';
          vm.logout();
        });
        $scope.$on('$destroy', stop);

        start();
      },
    ]);
})(window.angular);
