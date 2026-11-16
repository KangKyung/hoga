/**
 * 비대면 계좌 개설 — 서버가 내려 주는 단계 화면(HTML/CSS/JS, 프레임워크 없음).
 *
 * 앱 배포 없이 약관·문구·단계를 바꿀 수 있게 웹으로 두고, 웹이 할 수 없는 일만 앱에 부탁한다.
 *   saveDraft/clearDraft : 신청서 ID·토큰을 앱 보안 저장소에(웹 저장소에 두지 않는다) → 나갔다 와도 이어서
 *   captureIdCard        : 앱이 카메라·앨범을 열고 서버에 직접 올린다. 이 화면은 결과(idCardResult)만 받는다
 *   accountOpened        : 끝 → 앱이 로그인 화면으로 돌아가 아이디를 채운다
 * 서버가 단계 순서를 강제하므로 이 화면은 "지금 단계"를 서버에서 받아 그린다.
 */
(function () {
  'use strict';

  var I = window.HogaI18n;
  var bridge = window.HogaBridge;
  var analytics = window.HogaAnalytics;
  var $ = function (id) {
    return document.getElementById(id);
  };

  var STEPS = ['terms', 'profile', 'phone', 'idcard', 'done'];
  var app = null; // { id, token }
  var view = null; // 서버 신청서(가린 값)
  var finished = null; // { accountNo, username }
  var busy = false;

  // ---------- 서버 ----------

  function api(method, path, body) {
    var headers = {};
    if (app) headers['x-application-token'] = app.token;
    // POST는 내용이 없어도 {}를 보낸다(서버는 JSON 형식의 빈 본문을 거절한다)
    if (method === 'POST') headers['content-type'] = 'application/json';
    return fetch('/account-open' + path, {
      method: method,
      headers: headers,
      body: method === 'POST' ? JSON.stringify(body === undefined ? {} : body) : undefined,
    })
      .catch(function () {
        throw { error: 'NETWORK' };
      })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw data || { error: 'HTTP_' + res.status };
          return data;
        });
      });
  }

  function errorText(e) {
    var code = (e && e.error) || 'generic';
    var key = 'web.open.err.' + code;
    var text = I.t(key);
    return text === key ? I.t('web.open.err.generic', { code: code }) : text;
  }

  function showError(e, step) {
    $('error').textContent = errorText(e);
    $('error').classList.remove('hidden');
    analytics.track('account_open_step', { step: step, result: 'error', error: (e && e.error) || 'generic' });
    if (e && (e.error === 'NOT_FOUND' || e.error === 'ALREADY_DONE')) $('restart').classList.remove('hidden');
  }

  function clearError() {
    $('error').classList.add('hidden');
  }

  /** 버튼 연타·중복 요청 방지 */
  function run(step, task) {
    if (busy) return;
    busy = true;
    clearError();
    document.getElementById('root').setAttribute('aria-busy', 'true');
    task()
      .catch(function (e) {
        showError(e, step);
      })
      .then(function () {
        busy = false;
        document.getElementById('root').setAttribute('aria-busy', 'false');
      });
  }

  function advanced(next) {
    var before = view ? view.step : null;
    view = next;
    if (before && before !== next.step) analytics.track('account_open_step', { step: before, result: 'ok' });
    render();
  }

  // ---------- 그리기 ----------

  function current() {
    return finished ? 'finished' : view ? view.step : 'terms';
  }

  function render() {
    var step = current();
    var index = STEPS.indexOf(step);
    document.querySelectorAll('.step').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-step') === step);
    });
    document.querySelectorAll('#progress li').forEach(function (li, i) {
      li.classList.toggle('on', finished ? true : i <= index);
    });
    $('stepLabel').textContent = finished ? '' : I.t('web.open.step', { n: index + 1 });
    $('stepTitle').textContent = finished ? I.t('web.open.title') : I.t('web.open.steps.' + step);
    if (view && view.profile) {
      $('verified').textContent = view.idCardVerified ? I.t('web.open.verified', { name: view.profile.name, birth: view.profile.birth }) : '';
    }
    if (finished) $('accountNo').textContent = I.t('web.open.accountNo', { no: finished.accountNo });
  }

  function applyStrings() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = I.t(el.getAttribute('data-i18n'));
    });
    document.title = I.t('web.open.title');
    render();
  }

  // ---------- 시작·이어하기 ----------

  function startNew() {
    app = null;
    return api('POST', '', {}).then(function (created) {
      app = { id: created.id, token: created.token };
      if (bridge.inApp()) bridge.send('saveDraft', app);
      advanced({ step: created.step, profile: null, idCardVerified: false });
    });
  }

  function resume(draft) {
    app = draft;
    return api('GET', '/' + app.id)
      .then(function (v) {
        $('notice').textContent = I.t('web.open.resumed');
        $('notice').classList.remove('hidden');
        advanced(v);
      })
      .catch(function () {
        // 만료(30분)·서버 재시작 → 새로
        bridge.send('clearDraft', {});
        return startNew();
      });
  }

  function restart() {
    if (bridge.inApp()) bridge.send('clearDraft', {});
    finished = null;
    view = null;
    $('restart').classList.add('hidden');
    $('notice').classList.add('hidden');
    run('terms', startNew);
  }

  // ---------- 단계별 ----------

  function syncAgreeAll() {
    var boxes = document.querySelectorAll('.agree');
    var all = Array.prototype.every.call(boxes, function (b) {
      return b.checked;
    });
    $('agreeAll').checked = all;
    $('termsNext').disabled = !($('agreeTerms').checked && $('agreePrivacy').checked);
  }

  function bind() {
    $('agreeAll').addEventListener('change', function () {
      document.querySelectorAll('.agree').forEach(function (b) {
        b.checked = $('agreeAll').checked;
      });
      syncAgreeAll();
    });
    document.querySelectorAll('.agree').forEach(function (b) {
      b.addEventListener('change', syncAgreeAll);
    });
    $('termsNext').addEventListener('click', function () {
      run('terms', function () {
        return api('POST', '/' + app.id + '/terms', {
          required: $('agreeTerms').checked,
          privacy: $('agreePrivacy').checked,
          marketing: $('agreeMarketing').checked,
        }).then(advanced);
      });
    });

    $('profileNext').addEventListener('click', function () {
      run('profile', function () {
        return api('POST', '/' + app.id + '/profile', {
          name: $('name').value.trim(),
          birth: $('birth').value.trim(),
          phone: $('phone').value.replace(/\D/g, ''),
          username: $('username').value.trim().toLowerCase(),
        }).then(advanced);
      });
    });

    $('sendCode').addEventListener('click', function () {
      run('phone', function () {
        return api('POST', '/' + app.id + '/phone/send', {}).then(function (r) {
          $('sentTo').textContent = I.t('web.open.sentTo', { to: r.to });
          // 실제 문자 대신 개발용으로 화면에 보여 준다(모의)
          $('devCode').textContent = I.t('web.open.devCode', { code: r.devCode });
          $('devCode').classList.remove('hidden');
          $('sendCode').textContent = I.t('web.open.resend');
          $('code').focus();
        });
      });
    });
    $('code').addEventListener('input', function () {
      $('code').value = $('code').value.replace(/\D/g, '').slice(0, 6);
      $('verifyCode').disabled = $('code').value.length !== 6;
    });
    $('verifyCode').addEventListener('click', function () {
      run('phone', function () {
        return api('POST', '/' + app.id + '/phone/verify', { code: $('code').value }).then(advanced);
      });
    });

    $('capture').addEventListener('click', function () {
      if (busy) return;
      if (!bridge.inApp()) {
        showError({ error: 'generic' }, 'idcard');
        return;
      }
      busy = true;
      clearError();
      $('capture').disabled = true;
      $('capture').textContent = I.t('web.open.capturing');
      bridge.send('captureIdCard', {});
    });
    bridge.on('idCardResult', function (r) {
      busy = false;
      $('capture').disabled = false;
      $('capture').textContent = I.t('web.open.capture');
      if (!r.ok) {
        showError({ error: r.error }, 'idcard');
        return;
      }
      api('GET', '/' + app.id).then(advanced, function (e) {
        showError(e, 'idcard');
      });
    });

    $('complete').addEventListener('click', function () {
      if ($('password').value !== $('password2').value) {
        showError({ error: 'PASSWORD_MISMATCH' }, 'done');
        return;
      }
      run('done', function () {
        return api('POST', '/' + app.id + '/complete', { password: $('password').value, accountPin: $('pin').value }).then(
          function (r) {
            analytics.track('account_open_step', { step: 'done', result: 'ok' });
            finished = { accountNo: r.accountNo, username: r.username };
            // 끝난 신청서는 더 이어갈 일이 없다
            if (bridge.inApp()) bridge.send('clearDraft', {});
            render();
          },
        );
      });
    });
    $('goLogin').addEventListener('click', function () {
      if (bridge.inApp()) bridge.send('accountOpened', { username: finished.username });
    });
    $('restart').addEventListener('click', restart);
  }

  // ---------- 시작 ----------

  I.onChange(applyStrings);
  bridge.on('init', function (p) {
    if (p.theme) document.documentElement.setAttribute('data-theme', p.theme);
    if (p.locale && p.locale !== I.lang()) I.load(p.locale);
  });
  bridge.on('locale', function (p) {
    I.load(p.locale);
  });
  // 앱은 init 다음에 저장해 둔 신청서(draft)를 보낸다
  bridge.on('draft', function (d) {
    run('terms', function () {
      return d && d.id && d.token ? resume({ id: d.id, token: d.token }) : startNew();
    });
  });

  I.load(I.initial()).then(function () {
    bind();
    applyStrings();
    if (bridge.inApp()) {
      bridge.hello('account_open');
    } else {
      // 일반 브라우저(개발용): 이어하기 없이 새 신청서. 신분증 단계는 앱에서만
      run('terms', startNew);
    }
  });
})();
