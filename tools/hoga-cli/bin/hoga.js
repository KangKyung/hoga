#!/usr/bin/env node
// 저장소 어디서든: tools/hoga-cli/bin/hoga.js <명령>
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, ['--import', 'tsx', join(here, '../src/main.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: join(here, '..'),
  env: { ...process.env, HOGA_CWD: process.cwd() },
});
process.exit(r.status ?? 1);
