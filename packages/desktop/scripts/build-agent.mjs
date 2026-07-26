#!/usr/bin/env node
/**
 * Compile the Edge runtime so the desktop app can launch
 * `agent/dist/index.js` with plain Node semantics instead of a TS loader.
 *
 * Deliberately fault-tolerant:
 *   - `usb` is an optional native dependency; when its toolchain is absent
 *     the install still succeeds and USB support degrades at runtime.
 *   - `tsc` may report type errors from those missing optional typings but
 *     still emits JS. A non-zero tsc exit must NOT stop the desktop app
 *     from starting, so we only fail when no `dist/index.js` was produced.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'agent');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const opts = { cwd: AGENT_DIR, stdio: 'inherit', shell: process.platform === 'win32' };

if (!existsSync(join(AGENT_DIR, 'node_modules'))) {
  spawnSync(npm, ['install', '--no-audit', '--no-fund'], opts);
}
spawnSync(npm, ['run', 'build'], opts);

if (!existsSync(join(AGENT_DIR, 'dist', 'index.js'))) {
  console.warn('⚠ agent/dist/index.js was not produced — the desktop app will fall back to running the TypeScript sources.');
} else {
  console.log('✓ agent runtime compiled to agent/dist/index.js');
}