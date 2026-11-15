import { createServer } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const server = createServer(config);

await server.start();
server.log.info(
  { port: config.PORT, sim: config.SIM_INTERVAL_MS, dropSeq: config.FAULT_DROP_SEQ_RATE, orderDelay: config.FAULT_ORDER_DELAY_MS },
  'hoga mock exchange started',
);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info({ signal }, 'shutting down: closing WebSockets with 1012');
    server
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        server.log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  });
}
