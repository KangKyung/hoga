import { createGatewayServer, createServer } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const server = config.ROLE === 'gateway' ? createGatewayServer(config) : createServer(config);

await server.start();
server.log.info(
  {
    role: config.ROLE,
    port: config.PORT,
    redis: Boolean(config.REDIS_URL),
    sim: config.SIM_INTERVAL_MS,
    dropSeq: config.FAULT_DROP_SEQ_RATE,
    orderDelay: config.FAULT_ORDER_DELAY_MS,
  },
  'hoga server started',
);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info({ signal }, 'shutting down: closing WebSockets with 1012');
    // 정상 종료가 어딘가(예: 이미 죽은 Redis)에 걸려도 10초 뒤에는 끝낸다
    setTimeout(() => {
      server.log.error('shutdown timed out, exiting');
      process.exit(1);
    }, 10_000).unref();
    server
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        server.log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  });
}
