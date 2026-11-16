/**
 * 시세 팬아웃 + 장애 복구 (k6).
 *
 * 시나리오(03 문서의 1~3번):
 *   viewers  0 → VUS 명까지 늘린 뒤 유지. 각자 종목 1~3개 구독, 서버 시각(ts) ↔ 받은 시각 차이 = 전달 지연(20개 중 1개 표본)
 *   chaos    유지 중 관리 API로 모든 연결 끊기(1012) → 클라이언트가 앱과 같은 규칙으로 재접속:
 *            full jitter, 단 서버가 close reason에 준 재접속 창(retry-window, 연결 수 ÷ 초당 1,000)보다 좁히지 않는다.
 *            POLICY=fixed 로 돌리면 개선 전(항상 0~500ms) 동작을 재현한다.
 *            끊긴 순간부터 새 연결에서 첫 시세를 받기까지 = 복구 시간
 *
 * 실행: k6 run -e BASE=http://localhost:8090 -e VUS=2000 loadtest/ws-fanout.js
 * 같은 맥에서 k6와 서버를 함께 돌리므로 시계는 같고, 숫자는 "이 맥 한 대" 기준이다.
 */
import http from 'k6/http';
import {sleep} from 'k6';
import {Counter, Rate, Trend} from 'k6/metrics';
import {setTimeout, clearTimeout} from 'k6/timers';
import {WebSocket} from 'k6/websockets';

const BASE = __ENV.BASE || 'http://localhost:8090';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const VUS = Number(__ENV.VUS || 1000);
const RAMP = __ENV.RAMP || '60s';
const HOLD = __ENV.HOLD || '60s';
const CHAOS_AT = __ENV.CHAOS_AT || '';
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || 'hoga-admin-dev-token';
const SYMBOLS = ['000001', '000002', '000003', '000004', '000005'];

const tickLatency = new Trend('tick_latency', true);
const messages = new Counter('ws_messages');
const connected = new Rate('ws_connect_ok');
const recovery = new Trend('reconnect_recovery', true);
const serverClosed = new Counter('ws_server_closed');

const seconds = s => Number(String(s).replace('s', ''));
const total = seconds(RAMP) + seconds(HOLD);

export const options = {
  scenarios: {
    viewers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        {duration: RAMP, target: VUS},
        {duration: HOLD, target: VUS},
      ],
      gracefulRampDown: '5s',
      gracefulStop: '10s',
    },
    ...(CHAOS_AT
      ? {
          chaos: {
            executor: 'shared-iterations',
            vus: 1,
            iterations: 1,
            startTime: CHAOS_AT,
            exec: 'chaos',
          },
        }
      : {}),
  },
  thresholds: {
    ws_connect_ok: ['rate>0.99'],
    tick_latency: ['p(95)<250'],
    ...(CHAOS_AT ? {reconnect_recovery: ['p(99)<10000']} : {}),
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// VU마다 마지막으로 서버가 끊은 시각(다음 반복에서 복구 시간을 잰다)
let closedAt = 0;
let attempt = 0;
// 서버가 1012 close reason으로 알려 준 재접속 창(ms). 앱의 C++ MarketClient와 같은 규칙
let retryWindow = 0;
const POLICY = __ENV.POLICY || 'window'; // 'window' | 'fixed'(개선 전: 항상 [0, 500ms))

export default function () {
  // 시험 끝 무렵에는 새 연결을 열지 않는다(통계가 짧은 연결로 흐려지지 않게)
  const remaining = total - (Date.now() - startedAt) / 1000;
  if (remaining < 3) {
    sleep(Math.max(0, remaining));
    return;
  }
  if (closedAt) {
    // 앱(C++ MarketClient)과 같은 full jitter: [0, min(30s, max(500ms·2^(attempt-1), 서버 재접속 창)))
    attempt += 1;
    const cap = Math.min(30_000, Math.max(500 * 2 ** (attempt - 1), POLICY === 'window' ? retryWindow : 0));
    sleep((Math.random() * cap) / 1000);
  }
  const picks = SYMBOLS.slice().sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
  const ws = new WebSocket(WS);
  let opened = false;
  let firstTick = true;
  let byUs = false;
  // 남은 시험 시간이 지나면 스스로 닫는다
  const stopTimer = setTimeout(() => {
    byUs = true;
    ws.close();
  }, remaining * 1000);

  ws.onopen = () => {
    opened = true;
    connected.add(true);
    ws.send(JSON.stringify({op: 'sub', symbols: picks}));
  };
  let seen = 0;
  ws.onmessage = e => {
    // 부하 발생기(k6)가 먼저 한계에 닿지 않도록 메시지마다 JSON.parse 하지 않는다.
    // 시세(snap·delta·trade)는 "ts" 필드가 있다. 개수는 전부 세고, 지연은 20개 중 1개만 잰다.
    const data = e.data;
    const at = data.indexOf('"ts":');
    if (at < 0 || data.indexOf('"t":"pong"') >= 0) return;
    messages.add(1);
    if (firstTick && closedAt) {
      recovery.add(Date.now() - closedAt);
      closedAt = 0;
      attempt = 0;
      retryWindow = 0;
    }
    firstTick = false;
    if (seen++ % 20 === 0) tickLatency.add(Date.now() - parseInt(data.slice(at + 5), 10));
  };
  ws.onerror = () => {
    if (!opened) connected.add(false);
  };
  ws.onclose = e => {
    clearTimeout(stopTimer);
    if (e.code === 1012) {
      const m = /retry-window=(\d{1,7})/.exec(e.reason || '');
      retryWindow = m ? Number(m[1]) : 0;
    }
    if (!byUs && opened) {
      serverClosed.add(1);
      if (!closedAt) closedAt = Date.now();
    }
  };
}

const startedAt = Date.now();

/** 유지 구간 중간에 모든 연결을 끊는다(gateway 장애 대신 관리 API의 1012) */
export function chaos() {
  const res = http.post(`${BASE}/admin/api/disconnect`, '{}', {
    headers: {'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json'},
  });
  console.log(`chaos: disconnected ${res.json('closed')} clients`);
}
