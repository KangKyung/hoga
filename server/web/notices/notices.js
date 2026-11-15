/**
 * 공지사항 — AngularJS 1.8 (레거시 웹 화면 유지보수 연습).
 *
 * - 컨트롤러는 "controller as" 문법, 서비스로 API 분리, 필터로 번역·날짜 형식
 * - 상세는 주소 해시(#!/n-104)로 열어 웹뷰·브라우저의 뒤로 가기가 목록으로 돌아오게 한다
 * - ng-csp 모드라 eval 없이 동작한다(Content-Security-Policy: script-src 'self')
 */
(function (angular, I, bridge, analytics) {
  'use strict';

  angular
    .module('hogaNotices', [])
    .config([
      '$compileProvider',
      '$locationProvider',
      function ($compileProvider, $locationProvider) {
        $compileProvider.debugInfoEnabled(false);
        $locationProvider.hashPrefix('!');
      },
    ])

    // 번역 필터. 번역을 비동기로 받으므로 $stateful로 두어 매 digest마다 다시 계산한다.
    .filter('t', function () {
      function t(key, params) {
        return I.t(key, params);
      }
      t.$stateful = true;
      return t;
    })

    .filter('localDate', function () {
      function localDate(iso) {
        if (!iso) return '';
        var d = new Date(iso + 'T00:00:00');
        return new Intl.DateTimeFormat(I.lang(), { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
      }
      localDate.$stateful = true;
      return localDate;
    })

    .factory('noticeApi', [
      '$http',
      function ($http) {
        return {
          list: function (lang, category) {
            var params = { lang: lang };
            if (category && category !== 'all') params.category = category;
            return $http.get('/notices', { params: params }).then(function (r) {
              return r.data;
            });
          },
          get: function (id, lang) {
            return $http.get('/notices/' + encodeURIComponent(id), { params: { lang: lang } }).then(function (r) {
              return r.data;
            });
          },
        };
      },
    ])

    .controller('NoticesController', [
      '$scope',
      '$location',
      'noticeApi',
      function ($scope, $location, noticeApi) {
        var vm = this;
        vm.categories = ['all', 'service', 'maintenance', 'event'];
        vm.category = 'all';
        vm.query = '';
        vm.notices = [];
        vm.loaded = false;
        vm.detail = null;

        function reload() {
          return noticeApi.list(I.lang(), vm.category).then(function (list) {
            vm.notices = list;
            vm.loaded = true;
          });
        }

        function syncWithLocation() {
          var id = $location.path().replace(/^\//, '');
          if (!id) {
            vm.detail = null;
            return;
          }
          noticeApi.get(id, I.lang()).then(
            function (notice) {
              vm.detail = notice;
              analytics.track('view_notice', { notice_id: notice.id, category: notice.category });
              analytics.track('screen_view', { screen_name: 'notice_detail' });
            },
            function () {
              $location.path('/');
            },
          );
        }

        vm.select = function (category) {
          vm.category = category;
          analytics.track('filter_notices', { category: category });
          reload();
        };
        vm.open = function (id) {
          $location.path('/' + id);
        };
        vm.close = function () {
          $location.path('/');
        };

        $scope.$on('$locationChangeSuccess', syncWithLocation);

        function applyLang(lang) {
          return I.load(lang).then(function () {
            $scope.$applyAsync(function () {
              reload();
              if (vm.detail) syncWithLocation();
            });
          });
        }

        // 앱이 언어를 알려 주면 그걸 따른다(주소의 ?lang= 보다 우선)
        bridge.on('init', function (p) {
          if (p.theme) document.documentElement.setAttribute('data-theme', p.theme);
          if (p.locale && p.locale !== I.lang()) applyLang(p.locale);
        });
        bridge.on('locale', function (p) {
          applyLang(p.locale);
        });

        applyLang(I.initial()).then(function () {
          analytics.track('screen_view', { screen_name: 'notices' });
          bridge.hello('notices');
        });
      },
    ]);
})(window.angular, window.HogaI18n, window.HogaBridge, window.HogaAnalytics);
