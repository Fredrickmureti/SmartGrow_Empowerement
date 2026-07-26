#!/usr/bin/env node
/**
 * Phase 4.2.6 — Cross-platform service installer for AccrualFlow Edge.
 *
 * Usage:
 *   node install-service.cjs install
 *   node install-service.cjs uninstall
 *   node install-service.cjs start
 *   node install-service.cjs stop
 *   node install-service.cjs status
 *
 * Design:
 *   - Windows: node-windows registers a real Windows Service (auto-start,
 *     restart-on-failure). node-windows is a soft dep so the module works
 *     on macOS/Linux without pulling in win-only build tooling.
 *   - macOS:   writes a LaunchAgent plist to ~/Library/LaunchAgents/ and
 *     bootstraps it via `launchctl`. Runs under the user session (does
 *     not require sudo) which matches the AccrualFlow trust boundary —
 *     the workstation secret is scoped to the enrolling user.
 *   - Linux:   writes a systemd --user unit and enables/starts it.
 *
 * The service simply execs `node agent/dist/index.js` (or `tsx src/index.ts`
 * when run from source). All state — token, TLS cert, workstation config —
 * lives under `~/.accrualflow/edge/` and is shared with the tray app.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SERVICE_NAME = 'AccrualFlowEdge';
const SERVICE_DESC = 'AccrualFlow Edge - hardware runtime for the AccrualFlow ERP.';
const AGENT_ROOT = path.resolve(__dirname, '..');
const ENTRY = fs.existsSync(path.join(AGENT_ROOT, 'dist', 'index.js'))
  ? path.join(AGENT_ROOT, 'dist', 'index.js')
  : path.join(AGENT_ROOT, 'src', 'index.ts');
const NODE_BIN = process.execPath;

function log(msg) { process.stdout.write(`[edge-service] ${msg}\n`); }
function die(msg, code = 1) { process.stderr.write(`[edge-service] ${msg}\n`); process.exit(code); }

function winService() {
  let Service;
  try { ({ Service } = require('node-windows')); }
  catch { die('node-windows is not installed. Run: npm i -D node-windows (win32 only).'); }
  return new Service({
    name: SERVICE_NAME,
    description: SERVICE_DESC,
    script: ENTRY,
    nodeOptions: ENTRY.endsWith('.ts') ? ['--import', 'tsx'] : [],
    wait: 2,
    grow: 0.25,
    maxRestarts: 5,
    env: [{ name: 'ACCRUALFLOW_EDGE_CONFIG', value: path.join(os.homedir(), '.accrualflow', 'edge', 'workstation.json') }],
  });
}
function winInstall() {
  const svc = winService();
  svc.on('install', () => { log('installed; starting...'); svc.start(); });
  svc.on('alreadyinstalled', () => log('already installed; starting...'));
  svc.on('start', () => log('service started'));
  svc.on('error', (e) => die(`windows service error: ${e && e.message ? e.message : e}`));
  svc.install();
}
function winUninstall() {
  const svc = winService();
  svc.on('uninstall', () => log('uninstalled'));
  svc.on('error', (e) => die(`windows service error: ${e && e.message ? e.message : e}`));
  svc.uninstall();
}
function winCtl(action) {
  const r = spawnSync('sc', [action, SERVICE_NAME], { encoding: 'utf-8' });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exit(r.status ?? 0);
}

function macPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.accrualflow.edge.plist`);
}
function macPlistBody() {
  const logDir = path.join(os.homedir(), '.accrualflow', 'edge', 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const args = ENTRY.endsWith('.ts')
    ? `<string>${NODE_BIN}</string><string>--import</string><string>tsx</string><string>${ENTRY}</string>`
    : `<string>${NODE_BIN}</string><string>${ENTRY}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.accrualflow.edge</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, 'stdout.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'stderr.log')}</string>
  <key>EnvironmentVariables</key><dict>
    <key>ACCRUALFLOW_EDGE_CONFIG</key><string>${path.join(os.homedir(), '.accrualflow', 'edge', 'workstation.json')}</string>
  </dict>
</dict></plist>
`;
}
function macInstall() {
  const p = macPlistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, macPlistBody(), { mode: 0o644 });
  spawnSync('launchctl', ['unload', p], { encoding: 'utf-8' });
  const r = spawnSync('launchctl', ['load', '-w', p], { encoding: 'utf-8' });
  if (r.status !== 0) die(`launchctl load failed: ${r.stderr}`);
  log(`installed launch agent at ${p}`);
}
function macUninstall() {
  const p = macPlistPath();
  spawnSync('launchctl', ['unload', p], { encoding: 'utf-8' });
  try { fs.unlinkSync(p); } catch { /* ok */ }
  log('uninstalled launch agent');
}
function macCtl(action) {
  const label = 'com.accrualflow.edge';
  const map = { start: ['start', label], stop: ['stop', label], status: ['list', label] };
  const args = map[action]; if (!args) die(`unknown action ${action}`);
  const r = spawnSync('launchctl', args, { encoding: 'utf-8' });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  process.exit(r.status ?? 0);
}

function linuxUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'accrualflow-edge.service');
}
function linuxUnitBody() {
  const execStart = ENTRY.endsWith('.ts')
    ? `${NODE_BIN} --import tsx ${ENTRY}`
    : `${NODE_BIN} ${ENTRY}`;
  return `[Unit]
Description=${SERVICE_DESC}
After=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Environment=ACCRUALFLOW_EDGE_CONFIG=${path.join(os.homedir(), '.accrualflow', 'edge', 'workstation.json')}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}
function linuxInstall() {
  const p = linuxUnitPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, linuxUnitBody(), { mode: 0o644 });
  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf-8' });
  spawnSync('systemctl', ['--user', 'enable', '--now', 'accrualflow-edge.service'], { encoding: 'utf-8' });
  log(`installed systemd --user unit at ${p}`);
}
function linuxUninstall() {
  spawnSync('systemctl', ['--user', 'disable', '--now', 'accrualflow-edge.service'], { encoding: 'utf-8' });
  try { fs.unlinkSync(linuxUnitPath()); } catch { /* ok */ }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf-8' });
  log('uninstalled systemd --user unit');
}
function linuxCtl(action) {
  const map = { start: 'start', stop: 'stop', status: 'status' };
  const r = spawnSync('systemctl', ['--user', map[action] ?? 'status', 'accrualflow-edge.service'], { encoding: 'utf-8' });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  process.exit(r.status ?? 0);
}

const cmd = (process.argv[2] || '').toLowerCase();
const plat = process.platform;

if (!['install', 'uninstall', 'start', 'stop', 'status'].includes(cmd)) {
  die('usage: install-service.cjs <install|uninstall|start|stop|status>');
}

if (plat === 'win32') {
  if (cmd === 'install') winInstall();
  else if (cmd === 'uninstall') winUninstall();
  else winCtl(cmd);
} else if (plat === 'darwin') {
  if (cmd === 'install') macInstall();
  else if (cmd === 'uninstall') macUninstall();
  else macCtl(cmd);
} else if (plat === 'linux') {
  if (cmd === 'install') linuxInstall();
  else if (cmd === 'uninstall') linuxUninstall();
  else linuxCtl(cmd);
} else {
  die(`unsupported platform: ${plat}`);
}