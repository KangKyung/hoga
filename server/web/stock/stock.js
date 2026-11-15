/**
 * 종목정보 화면 — 프레임워크 없는 HTML/CSS/JS ("Custom HTML" 방식).
 *
 * 주소: /web/stock/?symbol=000001&lang=ko
 * - 앱 웹뷰 안: 현재가는 앱이 브리지로 밀어 준다(quote). 매수·매도는 앱의 네이티브 주문 창을 연다.
 * - 일반 브라우저: 5초마다 /symbols/:code/info 를 다시 읽는다. 주문 버튼은 숨긴다(주문은 앱에서만).
 */
(function () {
  'use strict';

  var I = window.HogaI18n;
  var bridge = window.HogaBridge;
  var analytics = window.HogaAnalytics;
  var $ = function (id) {
    return document.getElementById(id);
  };

  var params = new URLSearchParams(location.search);
  var symbol = /^\d{6}$/.test(params.get('symbol') || '') ? params.get('symbol') : '000001';
  var info = null;
  var lastPrice = null;
  var live = false;
  var pollTimer = null;

  function tone(price, base) {
    return price > base ? 'up' : price < base ? 'down' : 'flat';
  }

  function applyStrings() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = I.t(el.getAttribute('data-i18n'));
    });
    document.title = I.t('web.stock.title');
    $('noticesLink').href = '/web/notices/?lang=' + I.lang();
    $('liveLabel').textContent = I.t(live ? 'web.stock.live' : 'web.stock.polling');
    if (info) render();
  }

  function renderPrice() {
    if (!info) return;
    var price = lastPrice != null ? lastPrice : info.lastPrice;
    var diff = price - info.basePrice;
    var pct = info.basePrice ? (diff / info.basePrice) * 100 : 0;
    var cls = tone(price, info.basePrice);
    var arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
    $('price').textContent = I.number(price);
    $('price').className = 'price mono ' + cls;
    $('change').textContent =
      arrow + I.number(Math.abs(diff)) + ' (' + (diff >= 0 ? '+' : '-') + I.number(Math.abs(pct), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%)';
    $('change').className = 'mono ' + cls;
  }

  function render() {
    $('name').textContent = info.name;
    $('code').textContent = info.code;
    renderPrice();
    var day = info.day;
    $('open').textContent = day ? I.number(day.open) : '—';
    $('high').textContent = day ? I.number(day.high) : '—';
    $('low').textContent = day ? I.number(day.low) : '—';
    $('volume').textContent = day ? I.t('common.shares', { n: I.number(day.volume, { notation: 'compact' }) }) : '—';
    $('base').textContent = I.number(info.basePrice);
    $('tick').textContent = I.t('common.won', { n: I.number(info.tickSize) });
    $('upper').textContent = I.number(info.limits.upper);
    $('lower').textContent = I.number(info.limits.lower);
    $('profile').textContent = info.profile;
    $('sector').textContent = I.t('sector.' + info.sector);
    $('shares').textContent = I.number(info.sharesListed, { notation: 'compact' });
    $('marketCap').textContent = I.t('common.won', { n: I.number(info.marketCap, { notation: 'compact', maximumFractionDigits: 1 }) });
    $('root').setAttribute('aria-busy', 'false');
  }

  /** 5분 봉 종가로 그린 작은 선 그래프. 기준가는 점선 */
  function renderSpark(bars) {
    var svg = $('spark');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!bars.length || !info) return;
    var closes = bars.map(function (b) {
      return b[4];
    });
    var min = Math.min.apply(null, closes.concat(info.basePrice));
    var max = Math.max.apply(null, closes.concat(info.basePrice));
    var span = max - min || 1;
    var y = function (p) {
      return 76 - ((p - min) / span) * 72;
    };
    var ns = 'http://www.w3.org/2000/svg';
    var base = document.createElementNS(ns, 'line');
    base.setAttribute('x1', '0');
    base.setAttribute('x2', '300');
    base.setAttribute('y1', String(y(info.basePrice)));
    base.setAttribute('y2', String(y(info.basePrice)));
    base.setAttribute('class', 'base');
    svg.appendChild(base);
    var line = document.createElementNS(ns, 'polyline');
    line.setAttribute(
      'points',
      closes
        .map(function (c, i) {
          return ((i / Math.max(1, closes.length - 1)) * 300).toFixed(1) + ',' + y(c).toFixed(1);
        })
        .join(' '),
    );
    line.setAttribute('class', 'line ' + tone(closes[closes.length - 1], info.basePrice));
    svg.appendChild(line);
    svg.setAttribute('aria-label', I.t('web.stock.intraday'));
  }

  function loadInfo() {
    return fetch('/symbols/' + symbol + '/info?lang=' + I.lang())
      .then(function (r) {
        if (!r.ok) throw new Error('info ' + r.status);
        return r.json();
      })
      .then(function (body) {
        info = body;
        if (!live) lastPrice = null;
        render();
      });
  }

  function loadCandles() {
    return fetch('/candles/' + symbol + '?interval=5m&limit=48')
      .then(function (r) {
        return r.ok ? r.json() : { bars: [] };
      })
      .then(function (body) {
        renderSpark(body.bars || []);
      });
  }

  function setLive(on) {
    live = on;
    $('liveLabel').classList.toggle('on', on);
    $('liveLabel').textContent = I.t(on ? 'web.stock.live' : 'web.stock.polling');
    clearInterval(pollTimer);
    if (!on) pollTimer = setInterval(loadInfo, 5000);
  }

  function orderClick(side) {
    analytics.track('click_order_from_web', { symbol: symbol, side: side });
    // 웹은 주문을 직접 내지 않는다. 앱이 네이티브 주문 창을 열고, 사용자가 확인한 뒤에만 주문된다.
    bridge.send('openOrder', { symbol: symbol, side: side, price: lastPrice != null ? lastPrice : info && info.lastPrice });
  }

  // ---- 앱 → 웹 ----
  bridge.on('init', function (p) {
    if (p.theme) document.documentElement.setAttribute('data-theme', p.theme);
    setLive(true);
    if (p.locale && p.locale !== I.lang()) I.load(p.locale).then(loadInfo);
  });
  bridge.on('unsupported', function () {
    $('updateNotice').textContent = I.t('web.stock.needUpdate');
    $('updateNotice').classList.remove('hidden');
    $('buy').disabled = true;
    $('sell').disabled = true;
  });
  bridge.on('quote', function (p) {
    if (p.symbol !== symbol || typeof p.price !== 'number') return;
    lastPrice = p.price;
    renderPrice();
  });
  bridge.on('locale', function (p) {
    I.load(p.locale).then(loadInfo);
  });

  I.onChange(applyStrings);
  $('buy').addEventListener('click', function () {
    orderClick('bid');
  });
  $('sell').addEventListener('click', function () {
    orderClick('ask');
  });
  if (!bridge.inApp()) document.querySelector('.actions').classList.add('hidden');

  setLive(false);
  I.load(I.initial())
    .then(function () {
      return Promise.all([loadInfo(), loadCandles()]);
    })
    .then(function () {
      analytics.track('view_stock_info', { symbol: symbol, in_app: bridge.inApp() });
      analytics.track('screen_view', { screen_name: 'stock_info' });
    })
    .catch(function (e) {
      $('name').textContent = String(e.message || e);
    })
    .finally(function () {
      bridge.hello('stock_info');
    });
})();
