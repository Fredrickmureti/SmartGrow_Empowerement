/**
 * AccrualFlow Edge Desktop — Electron main process.
 *
 * Responsibilities:
 *   1. Own the OS window + tray icon; the app is tray-first, window on demand.
 *   2. Expose a strict IPC surface (see `preload.cjs`) that the renderer uses
 *      to read/write `~/.accrualflow/edge/workstation.json` and to spawn the
 *      bundled `agent/` runtime as a background child process. The renderer
 *      never touches Node APIs directly (`contextIsolation: true`,
 *      `nodeIntegration: false`).
 *   3. Persist a small settings blob in userData for GUI preferences that
 *      are NOT part of the enrolment secret.
 *
 * Everything security-sensitive (the raw workstation secret) is written to a
 * mode-0600 file inside the user's home directory, never into localStorage.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const http = require('node:http');
const supervisor = require('./supervisor-client.cjs');

const EDGE_HOME = path.join(os.homedir(), '.accrualflow', 'edge');
const WORKSTATION_JSON = path.join(EDGE_HOME, 'workstation.json');
const SETTINGS_JSON = path.join(app.getPath('userData'), 'edge-desktop-settings.json');
const AGENT_TOKEN_FILE = path.join(os.homedir(), '.pos-agent-token');
const AGENT_PORT = parseInt(process.env.AGENT_PORT || '8043', 10);

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {import('child_process').ChildProcess | null} */
let agentProc = null;
/** Ring buffer of the child runtime's stdout/stderr, for the Logs tab. */
const AGENT_LOG = [];
const AGENT_LOG_MAX = 200;
/** Supervision state for the managed child. */
let agentDesired = false;        // operator/autostart wants the child alive
let agentRestarts = [];          // timestamps of recent auto-restarts
let agentRestartTimer = null;
let agentLastError = null;

function pushAgentLog(stream, chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    AGENT_LOG.push({ ts: new Date().toISOString(), level: stream === 'stderr' ? 'error' : 'info', msg: line });
    if (AGENT_LOG.length > AGENT_LOG_MAX) AGENT_LOG.shift();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readAgentToken() {
  try { return fs.readFileSync(AGENT_TOKEN_FILE, 'utf-8').trim(); } catch { return null; }
}

function requestAgentJson(pathname, { method = 'GET', body = null, timeout = 2500, auth = false } = {}) {
  return new Promise((resolve) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const token = auth ? readAgentToken() : null;
    const req = http.request({
      host: '127.0.0.1',
      port: AGENT_PORT,
      path: pathname,
      method,
      timeout,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
        resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, body: json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('agent_timeout')); });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message, body: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function probeAgentHealth() {
  const r = await requestAgentJson('/health', { timeout: 1500 });
  if (!r.ok || !r.body) return { running: false, pid: null, source: 'none', error: r.error || (r.status ? `HTTP ${r.status}` : 'agent_unreachable') };
  const body = r.body || {};
  return {
    running: true,
    pid: typeof body.pid === 'number' ? body.pid : null,
    source: agentProc && !agentProc.killed ? 'managed' : 'loopback',
    version: typeof body.version === 'string' ? body.version : null,
  };
}

function ensureEdgeHome() {
  fs.mkdirSync(EDGE_HOME, { recursive: true, mode: 0o700 });
}

function readWorkstation() {
  try {
    const raw = fs.readFileSync(WORKSTATION_JSON, 'utf-8');
    const parsed = JSON.parse(raw);
    // Never surface the raw secret to the renderer — it stays on disk. We
    // return only the identity fields the UI needs to render.
    return {
      exists: true,
      workstation_id: parsed.workstation_id ?? null,
      organization_id: parsed.organization_id ?? null,
      name: parsed.name ?? null,
      supabase_url: parsed.supabase_url ?? null,
      has_secret: Boolean(parsed.workstation_secret),
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false };
    return { exists: false, error: String(err) };
  }
}

function writeWorkstation(payload) {
  ensureEdgeHome();
  // Atomic write + chmod 0600 so a curious sibling process on the machine
  // cannot read the secret.
  const tmp = WORKSTATION_JSON + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, WORKSTATION_JSON);
  return { ok: true };
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf-8')); } catch { return {}; }
}
function writeSettings(next) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_JSON), { recursive: true });
    fs.writeFileSync(SETTINGS_JSON, JSON.stringify(next, null, 2));
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
}

function createWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0d10',
    title: 'AccrualFlow Edge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.EDGE_DESKTOP_DEV_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  // Any external link opens in the OS default browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  // A 1x1 transparent icon is a safe cross-platform default. Real branding
  // ships in `resources/tray-{platform}.png` and is loaded at packaging time.
  const iconPath = path.join(__dirname, 'tray-icon.png');
  const image = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('AccrualFlow Edge');
  const menu = Menu.buildFromTemplate([
    { label: 'Open dashboard', click: createWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', createWindow);
}

function stopAgent() {
  agentDesired = false;
  if (agentRestartTimer) { clearTimeout(agentRestartTimer); agentRestartTimer = null; }
  if (agentProc && !agentProc.killed) {
    try { agentProc.kill('SIGTERM'); } catch { /* ignore */ }
  }
  agentProc = null;
}

function agentRoot() {
  if (process.env.ACCRUALFLOW_AGENT_ROOT) return path.resolve(process.env.ACCRUALFLOW_AGENT_ROOT);
  // Packaged: the agent tree ships as an extra resource next to app.asar.
  const packaged = path.join(process.resourcesPath || '', 'agent');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  // Dev: the monorepo sibling.
  return path.resolve(__dirname, '..', '..', '..', 'agent');
}

function findAgentLaunch() {
  const root = agentRoot();
  const distEntry = path.join(root, 'dist', 'index.js');
  if (fs.existsSync(distEntry)) return { mode: 'node', entry: distEntry, cwd: root };
  const srcEntry = path.join(root, 'src', 'index.ts');
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(srcEntry) && fs.existsSync(tsxCli)) return { mode: 'tsx', entry: srcEntry, tsxCli, cwd: root };
  if (fs.existsSync(srcEntry)) return { mode: 'npm-dev', entry: srcEntry, cwd: root };
  return null;
}

/**
 * Spawn the runtime child. Stdio is piped into the ring buffer so a failed
 * boot is diagnosable from the Logs tab instead of a terminal.
 */
function spawnAgentChild(launch) {
  const env = { ...process.env, ACCRUALFLOW_EDGE_CONFIG: WORKSTATION_JSON };
  let command = process.execPath;
  let args = [];
  if (launch.mode === 'node') {
    env.ELECTRON_RUN_AS_NODE = '1';
    args = ['--enable-source-maps', launch.entry];
  } else if (launch.mode === 'tsx') {
    env.ELECTRON_RUN_AS_NODE = '1';
    args = [launch.tsxCli, launch.entry];
  } else {
    command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    args = ['run', 'dev'];
  }
  pushAgentLog('stdout', `[desktop] launching runtime (${launch.mode}): ${launch.entry}`);
  const child = spawn(command, args, {
    cwd: launch.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: launch.mode === 'npm-dev' && process.platform === 'win32',
  });
  child.stdout?.on('data', (b) => pushAgentLog('stdout', b));
  child.stderr?.on('data', (b) => pushAgentLog('stderr', b));
  child.on('error', (err) => {
    agentLastError = String(err && err.message ? err.message : err);
    pushAgentLog('stderr', `[desktop] spawn error: ${agentLastError}`);
  });
  child.on('exit', (code, signal) => {
    if (child !== agentProc) return;
    agentProc = null;
    pushAgentLog('stderr', `[desktop] runtime exited (code=${code} signal=${signal ?? 'none'})`);
    if (agentDesired) scheduleAgentRestart();
  });
  return child;
}

/** Exponential backoff, capped, with a 5-per-60s circuit breaker. */
function scheduleAgentRestart() {
  const now = Date.now();
  agentRestarts = agentRestarts.filter((t) => now - t < 60_000);
  if (agentRestarts.length >= 5) {
    agentDesired = false;
    agentLastError = 'restart_limit_reached';
    pushAgentLog('stderr', '[desktop] runtime crashed 5 times in 60s — supervision paused. Start it manually to retry.');
    return;
  }
  const delay = [1000, 2000, 5000, 10_000, 30_000][agentRestarts.length] ?? 30_000;
  agentRestarts.push(now);
  pushAgentLog('stdout', `[desktop] restarting runtime in ${delay}ms`);
  if (agentRestartTimer) clearTimeout(agentRestartTimer);
  agentRestartTimer = setTimeout(() => {
    agentRestartTimer = null;
    if (!agentDesired) return;
    const launch = findAgentLaunch();
    if (launch) agentProc = spawnAgentChild(launch);
  }, delay);
}

/**
 * Start the runtime and WAIT until `/health` answers (or the attempt fails).
 * Returns the real reason on failure plus the tail of the child's output.
 */
async function startAgent({ auto = false } = {}) {
  const already = await probeAgentHealth();
  if (already.running) {
    // Something already owns port 8043 (service supervisor or a manual
    // `npm run dev`). Do not fight it.
    return { ok: true, pid: already.pid, external: already.source === 'loopback', source: already.source };
  }
  if (agentProc) stopAgent();
  const launch = findAgentLaunch();
  if (!launch) {
    agentLastError = 'agent_not_bundled';
    return { ok: false, error: 'agent_not_bundled', detail: `no runtime found under ${agentRoot()}`, log: AGENT_LOG.slice(-40) };
  }
  agentLastError = null;
  agentDesired = true;
  agentRestarts = [];
  try {
    agentProc = spawnAgentChild(launch);
  } catch (err) {
    agentDesired = false;
    agentLastError = String(err);
    return { ok: false, error: String(err), log: AGENT_LOG.slice(-40) };
  }
  // Poll /health for up to 15s.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (!agentProc && !agentRestartTimer) break; // died and gave up
    const h = await probeAgentHealth();
    if (h.running) return { ok: true, pid: h.pid ?? agentProc?.pid ?? null, mode: launch.mode, auto };
  }
  const error = agentLastError || 'agent_did_not_become_healthy';
  return { ok: false, error, mode: launch.mode, log: AGENT_LOG.slice(-40) };
}

// ── IPC surface ──────────────────────────────────────────────────────────
ipcMain.handle('workstation:read', () => readWorkstation());
ipcMain.handle('workstation:write', (_e, payload) => {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid_payload' };
  return writeWorkstation(payload);
});
ipcMain.handle('workstation:clear', () => {
  try { fs.unlinkSync(WORKSTATION_JSON); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('settings:read', () => readSettings());
ipcMain.handle('settings:write', (_e, next) => writeSettings(next ?? {}));
// Phase 4.2.8 — update channel check. Read-only: it fetches the channel
// manifest and reports applicability. It never downloads or runs an
// installer; the operator opens the signed artifact themselves.
ipcMain.handle('updates:check', async (_e, opts) => {
  const { checkForUpdate } = require('./updater.cjs');
  const ws = readWorkstation() || {};
  const settings = readSettings() || {};
  return checkForUpdate({
    currentVersion: app.getVersion(),
    installId: ws.workstation_id || 'unassigned',
    channel: (opts && opts.channel) || settings.update_channel || 'stable',
    channelUrl: (opts && opts.channelUrl) || settings.update_channel_url || null,
  });
});

ipcMain.handle('agent:start', () => startAgent());
ipcMain.handle('agent:stop', () => { stopAgent(); return { ok: true }; });

/**
 * Browser pairing material.
 *
 * This is the LOOPBACK token (`~/.pos-agent-token`) that a browser must send
 * as `Authorization: Bearer …` to reach protected agent routes. It is NOT the
 * workstation secret in `workstation.json` — that one authenticates this
 * device to AccrualFlow's cloud and is useless to the local agent. Operators
 * confused the two, so the two credentials now live in visually distinct
 * panels with distinct copy.
 *
 * When auth is disabled we deliberately return no token: there is nothing to
 * paste and the UI must say so instead of handing out a stale secret.
 */
function agentAuthDisabled() {
  const v = process.env.AGENT_AUTH_DISABLED;
  return v === '1' || v === 'true';
}
ipcMain.handle('agent:pairing', () => {
  const authDisabled = agentAuthDisabled();
  const tlsPort = parseInt(process.env.AGENT_TLS_PORT || '8443', 10);
  if (authDisabled) {
    return {
      ok: true,
      authDisabled: true,
      token: null,
      tokenPath: AGENT_TOKEN_FILE,
      baseUrl: `http://127.0.0.1:${AGENT_PORT}`,
      tlsUrl: `https://127.0.0.1:${tlsPort}`,
    };
  }
  const token = readAgentToken();
  return {
    ok: true,
    authDisabled: false,
    token: token || null,
    tokenPath: AGENT_TOKEN_FILE,
    baseUrl: `http://127.0.0.1:${AGENT_PORT}`,
    tlsUrl: `https://127.0.0.1:${tlsPort}`,
    error: token ? undefined : 'token_not_generated',
  };
});

/**
 * Rotate the loopback token: delete the file and bounce the runtime so it
 * mints a fresh one on boot. Every previously paired browser must re-pair.
 */
ipcMain.handle('agent:rotateToken', async () => {
  if (agentAuthDisabled()) return { ok: false, error: 'auth_disabled' };
  try { fs.rmSync(AGENT_TOKEN_FILE, { force: true }); }
  catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
  stopAgent();
  // Give the listener a moment to release the port before the restart probe.
  await sleep(500);
  const started = await startAgent();
  const token = readAgentToken();
  if (!token) {
    return {
      ok: false,
      error: started.ok ? 'token_not_generated' : (started.error || 'agent_restart_failed'),
      detail: started.detail,
    };
  }
  return { ok: true, token };
});

ipcMain.handle('agent:status', async () => {
  const h = await probeAgentHealth();
  return {
    ...h,
    supervised: agentDesired,
    restarting: Boolean(agentRestartTimer),
    error: h.running ? undefined : (agentLastError || h.error),
  };
});
ipcMain.handle('agent:logs', async () => {
  const r = await requestAgentJson('/support-bundle', { timeout: 5000, auth: true });
  if (!r.ok) {
    // Runtime unreachable → fall back to whatever the child printed before
    // it died, so a failed boot is diagnosable inside the app.
    return {
      ok: AGENT_LOG.length > 0,
      status: r.status,
      source: 'desktop_child',
      error: r.error || r.body?.error || `HTTP ${r.status}`,
      entries: AGENT_LOG.slice(),
    };
  }
  const entries = Array.isArray(r.body?.logs) ? r.body.logs : [];
  return { ok: true, status: r.status, source: 'agent', entries, generated_at: r.body?.generated_at };
});

/**
 * Proxy a probe request to the local agent over loopback. Bearer token
 * is read from disk here so the renderer never sees it. Timeout is
 * bounded (8 s) because probes can drive real transports; the agent's
 * own 5 s per-(device, op) rate limit protects hardware from click
 * storms.
 */
ipcMain.handle('agent:probe', async (_e, payload) => {
  const token = readAgentToken();
  const body = Buffer.from(JSON.stringify(payload ?? {}));
  return await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: AGENT_PORT,
      path: '/probe',
      method: 'POST',
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status: res.statusCode ?? 0, ...JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode ?? 0, success: false, error: text || 'invalid_response' }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('probe_timeout')); });
    req.on('error', (err) => resolve({ status: 0, success: false, error: err.message }));
    req.write(body);
    req.end();
  });
});

ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(String(url)));

// Phase 4.2.6 — supervisor IPC surface. The tray app becomes a client of the
// platform-native service that hosts the runtime. Install/uninstall shell
// out to `agent/scripts/install-service.cjs`; the other ops go over the
// supervisor pipe/socket.
const { spawn: spawnP } = require('node:child_process');
function installerPath() {
  const candidates = [
    path.join(agentRoot(), 'scripts', 'install-service.cjs'),
    path.join(process.resourcesPath || '', 'agent', 'scripts', 'install-service.cjs'),
    path.resolve(__dirname, '..', '..', '..', 'agent', 'scripts', 'install-service.cjs'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}
function runInstaller(subcmd) {
  return new Promise((resolve) => {
    const script = installerPath();
    if (!script) {
      return resolve({
        ok: false,
        error: 'installer_not_bundled',
        detail: `no install-service.cjs under ${agentRoot()} — repackage with the agent bundled as an extra resource`,
      });
    }
    const child = spawnP(process.execPath, [script, subcmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ACCRUALFLOW_AGENT_ROOT: agentRoot(),
        ACCRUALFLOW_EDGE_CONFIG: WORKSTATION_JSON,
      },
    });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b.toString('utf-8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf-8'); });
    child.on('error', (e) => resolve({ ok: false, error: String(e && e.message ? e.message : e), stdout: out, stderr: err }));
    child.on('close', (code) => resolve({
      ok: code === 0,
      code,
      stdout: out,
      stderr: err,
      error: code === 0 ? undefined : (err.trim().split('\n').slice(-3).join(' ') || `exit ${code}`),
    }));
  });
}
ipcMain.handle('supervisor:status',  () => supervisor.send('status'));
ipcMain.handle('supervisor:ping',    () => supervisor.send('ping'));
ipcMain.handle('supervisor:reload',  () => supervisor.send('reload_origins'));
ipcMain.handle('supervisor:shutdown', () => supervisor.send('shutdown'));
// Phase 4.2.7 — certificate lifecycle. `certStatus` is read-only and safe
// to poll; `rotate` / `installCert` / `uninstallCert` are operator-
// initiated only and may trigger an OS elevation prompt in the agent.
ipcMain.handle('supervisor:certStatus',     () => supervisor.send('cert_status', {}, 15000));
ipcMain.handle('supervisor:rotateCert',     () => supervisor.send('rotate_cert', {}, 15000));
ipcMain.handle('supervisor:installCert',    () => supervisor.send('install_cert', {}, 120000));
ipcMain.handle('supervisor:uninstallCert',  () => supervisor.send('uninstall_cert', {}, 120000));
ipcMain.handle('supervisor:install',   async () => {
  const r = await runInstaller('install');
  // The service now owns port 8043 — release our own child so the two
  // runtimes do not fight over the loopback listener.
  if (r.ok) stopAgent();
  return r;
});
ipcMain.handle('supervisor:uninstall', () => runInstaller('uninstall'));
ipcMain.handle('supervisor:start',     async () => {
  const r = await runInstaller('start');
  if (r.ok) stopAgent();
  return r;
});
ipcMain.handle('supervisor:stop',      () => runInstaller('stop'));
ipcMain.handle('supervisor:serviceStatus', async () => {
  const script = installerPath();
  if (!script) return { ok: false, installerAvailable: false, error: 'installer_not_bundled' };
  const r = await runInstaller('status');
  return { ...r, installerAvailable: true };
});

// ── Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  ensureEdgeHome();
  createTray();
  createWindow();
  // Auto-start the runtime unless the operator opted out or a
  // platform service / manual dev process already owns the port.
  const settings = readSettings() || {};
  if (settings.agent_autostart !== false) {
    const r = await startAgent({ auto: true });
    if (!r.ok) pushAgentLog('stderr', `[desktop] autostart failed: ${r.error}`);
  }
});

// Tray-first: closing the last window does NOT quit the app.
app.on('window-all-closed', (e) => { e.preventDefault(); });
app.on('before-quit', stopAgent);
