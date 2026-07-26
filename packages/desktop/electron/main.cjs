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

const EDGE_HOME = path.join(os.homedir(), '.accrualflow', 'edge');
const WORKSTATION_JSON = path.join(EDGE_HOME, 'workstation.json');
const SETTINGS_JSON = path.join(app.getPath('userData'), 'edge-desktop-settings.json');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {import('child_process').ChildProcess | null} */
let agentProc = null;

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
  if (agentProc && !agentProc.killed) {
    try { agentProc.kill('SIGTERM'); } catch { /* ignore */ }
  }
  agentProc = null;
}

/**
 * Launch the bundled agent (`../../agent`) with the workstation config path
 * pre-injected. In production the agent binary is embedded in the app
 * resources; here we just spawn Node against the source tree for dev use.
 */
function startAgent() {
  stopAgent();
  const agentEntry = path.resolve(__dirname, '..', '..', '..', 'agent', 'src', 'index.ts');
  if (!fs.existsSync(agentEntry)) return { ok: false, error: 'agent_not_bundled' };
  try {
    agentProc = spawn(process.execPath, ['--enable-source-maps', agentEntry], {
      env: { ...process.env, ACCRUALFLOW_EDGE_CONFIG: WORKSTATION_JSON },
      stdio: 'ignore',
      detached: false,
    });
    return { ok: true, pid: agentProc.pid };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
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
ipcMain.handle('agent:start', () => startAgent());
ipcMain.handle('agent:stop', () => { stopAgent(); return { ok: true }; });
ipcMain.handle('agent:status', () => ({
  running: Boolean(agentProc && !agentProc.killed),
  pid: agentProc?.pid ?? null,
}));
ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(String(url)));

// ── Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureEdgeHome();
  createTray();
  createWindow();
});

// Tray-first: closing the last window does NOT quit the app.
app.on('window-all-closed', (e) => { e.preventDefault(); });
app.on('before-quit', stopAgent);
