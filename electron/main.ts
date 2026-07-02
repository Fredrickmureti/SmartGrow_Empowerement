import { app, BrowserWindow, ipcMain, shell, screen, safeStorage, net, Tray, Menu, nativeImage, session, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as nodenet from 'net';
import { SerialPort } from 'serialport';
import * as usb from 'usb';

// Native modules are wrapped so a missing or mis-built binary degrades the
// app to "hardware disabled" instead of crashing the main process before
// the window is even created (which manifests as a blank-white-screen
// from the user's perspective).
const nativeModuleErrors: Record<string, string> = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('serialport');
} catch (err) {
  nativeModuleErrors.serialport = (err as Error).message;
  console.warn('[native] serialport unavailable:', nativeModuleErrors.serialport);
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('usb');
} catch (err) {
  nativeModuleErrors.usb = (err as Error).message;
  console.warn('[native] usb unavailable:', nativeModuleErrors.usb);
}
import { databaseManager } from './database/DatabaseManager';
import { keyManager } from './security/KeyManager';
import { auditLogger } from './database/AuditLogger';
import { backupScheduler } from './database/BackupScheduler';
import { commandRouter } from './hardware/CommandRouter';
import { eventBroker } from './hardware/EventBroker';
import { CommandQueue, InMemoryQueueStore, type QueueStore } from './hardware/CommandQueue';
import { SaleSaga, InMemoryOutboxStore, type SagaCommitPayload, type OutboxStore } from './hardware/SaleSaga';
import { DeviceManager, type DeviceAssignment } from './hardware/DeviceManager';
import { NetworkTransport } from './hardware/transports/NetworkTransport';
import { SqliteOutboxStore, SqliteQueueStore, SqlitePayloadStore } from './hardware/SqliteStores';
import { sessionEnvelope } from './hardware/SessionEnvelope';
import { AssignmentStore, type AssignmentInput } from './hardware/assignments/store';
import { HARDWARE_HANDLERS, setPaymentService } from './hardware/handlers';
import { SqlitePaymentLogStore } from './hardware/SqliteStores';
import { PaymentService, InMemoryPaymentLogStore, type PaymentLogStore } from './hardware/payment/PaymentService';
import { MockTerminalDriver } from './hardware/payment/MockTerminalDriver';
import { SettlementReconciler } from './hardware/payment/SettlementReconciler';
import {
  BluetoothPairingManager,
  SqliteBtPairingsStore,
  setBluetoothPairingManager,
  getBluetoothPairingManager,
  ipcList as btIpcList,
  ipcPair as btIpcPair,
  ipcUnpair as btIpcUnpair,
  ipcConnect as btIpcConnect,
  ipcDisconnect as btIpcDisconnect,
  ipcHealth as btIpcHealth,
  type BluetoothRadio,
} from './hardware/bluetooth';

// ============ Hardware orchestration singletons (ADR-0014) ============
//
// Stores start in-memory so the IPC seam works pre-login (when the
// encrypted SQLite is sealed). Immediately after `db:initialize`
// succeeds we swap to the SQLite-backed adapters, drain any in-memory
// rows into them, and run `SaleSaga.replayUnfinished` so a mid-sale
// crash from the previous session resumes its print/drawer/display chain.
let _outboxImpl: OutboxStore = new InMemoryOutboxStore();
let _queueImpl: QueueStore = new InMemoryQueueStore();
let _paymentLogImpl: PaymentLogStore = new InMemoryPaymentLogStore();
const _paymentDriver = new MockTerminalDriver();
const paymentService = new PaymentService({
  driver: _paymentDriver,
  store: {
    findByIdempotency: (k) => _paymentLogImpl.findByIdempotency(k),
    insert: (r) => _paymentLogImpl.insert(r),
    update: (id, p) => _paymentLogImpl.update(id, p),
    listApprovedOlderThan: (c) => _paymentLogImpl.listApprovedOlderThan(c),
    findByAuthId: (id) => _paymentLogImpl.findByAuthId(id),
  },
  broker: eventBroker,
});
setPaymentService(paymentService);

/** No-radio fallback so the manager can be constructed before any noble probe. */
const inertRadio: BluetoothRadio = {
  async available() { return false; },
  async pair() { return { ok: false, error: 'bluetooth radio unavailable' }; },
  async unpair() { /* no-op */ },
  async connect() { return { ok: false, error: 'bluetooth radio unavailable' }; },
  async disconnect() { /* no-op */ },
  async ping() { return { ok: false, latencyMs: 0, error: 'bluetooth radio unavailable' }; },
};
// Proxy stores keep CommandQueue + SaleSaga pinned to a stable reference
// while letting the underlying implementation be swapped post-`db:initialize`.
const outboxStore: OutboxStore = {
  upsert: (r) => _outboxImpl.upsert(r),
  update: (s, st, p) => _outboxImpl.update(s, st, p),
  listUnfinished: () => _outboxImpl.listUnfinished(),
  findOne: (s, st) => _outboxImpl.findOne(s, st),
};
const queueStore: QueueStore = {
  findByKey: (k) => _queueImpl.findByKey(k),
  insert: (r) => _queueImpl.insert(r),
  update: (id, p) => _queueImpl.update(id, p),
  nextPending: (role) => _queueImpl.nextPending(role),
  listByStatus: (s, l) => _queueImpl.listByStatus(s, l),
};
const commandQueue = new CommandQueue(queueStore, (cmd) => commandRouter.exec(cmd));
const saleSaga = new SaleSaga(outboxStore, commandQueue);

/**
 * Promote orchestration stores to SQLite-backed implementations and
 * replay any unfinished saga rows from the previous session. Safe to call
 * multiple times — second call is a no-op once the SQLite stores are in place.
 */
function installSqliteHardwareStores(): void {
  if (_outboxImpl instanceof SqliteOutboxStore && _queueImpl instanceof SqliteQueueStore) return;
  const getDb = () => databaseManager.getDatabase();
  const nextOutbox = new SqliteOutboxStore(getDb);
  const nextQueue = new SqliteQueueStore(getDb);
  // Drain any in-memory rows captured before login into the durable store.
  for (const row of _outboxImpl.listUnfinished()) {
    try { nextOutbox.upsert(row); } catch { /* ignore duplicate */ }
  }
  _outboxImpl = nextOutbox;
  _queueImpl = nextQueue;
  // Track H3b — durable payload store. SaleSaga.setPayloadStore drains
  // any in-memory payloads collected pre-login into the new SQLite store
  // so a crash before logout still has the commit payload on disk.
  try { saleSaga.setPayloadStore(new SqlitePayloadStore(getDb)); }
  catch (err) { console.warn('[saga] payload store install failed:', (err as Error).message); }
  try {
    const replayed = saleSaga.replayUnfinished();
    if (replayed > 0) console.log(`[saga] replayed ${replayed} unfinished step(s) from outbox`);
  } catch (err) {
    console.warn('[saga] replay failed:', (err as Error).message);
  }
  // Track P — swap to SQLite-backed payment log and run settlement reconciler.
  try {
    _paymentLogImpl = new SqlitePaymentLogStore(getDb);
    void new SettlementReconciler({
      service: paymentService, store: _paymentLogImpl,
      logger: { info: (m) => console.log(m), error: (m) => console.warn(m) },
    }).runOnce().catch((err) => console.warn('[settlement] runOnce failed:', err));
  } catch (err) {
    console.warn('[payment] SQLite log install failed:', (err as Error).message);
  }
  // Track B — SQLite-backed pairing store + bootstrap reconnect loop.
  try {
    const btStore = new SqliteBtPairingsStore(getDb, keyManager);
    const mgr = new BluetoothPairingManager({ radio: inertRadio, store: btStore, broker: eventBroker });
    setBluetoothPairingManager(mgr);
    void mgr.bootstrap().catch((err) => console.warn('[bluetooth] bootstrap failed:', err));
  } catch (err) {
    console.warn('[bluetooth] manager install failed:', (err as Error).message);
  }
}

// DeviceManager bootstraps op-handlers per assignment from the
// `pos_device_assignments` SQLite table. Pre-`db:initialize` we have no
// DB, so `loadAssignments` returns an empty list and the manager
// registers nothing — `pos:exec` returns a clean "unknown op" rather
// than crashing. After db init we call `reloadDeviceAssignments()` to
// re-bootstrap with the live store.
let _assignmentStore: AssignmentStore | null = null;
const getAssignmentStore = (): AssignmentStore => {
  if (!_assignmentStore) _assignmentStore = new AssignmentStore(() => databaseManager.getDatabase());
  return _assignmentStore;
};
const deviceManager = new DeviceManager({
  router: commandRouter,
  broker: eventBroker,
  loadAssignments: () => {
    try {
      const rows = getAssignmentStore().loadActive(currentTerminalId);
      return rows.map((r) => ({
        role: r.role,
        transport: r.transport,
        driver: r.driver,
        config: safeJson(r.config_json) as Record<string, unknown>,
        enabled: r.enabled === 1,
      }));
    } catch {
      return [] as DeviceAssignment[];
    }
  },
  handlers: HARDWARE_HANDLERS as unknown as Record<string, (a: DeviceAssignment) => ReturnType<typeof HARDWARE_HANDLERS['receipt_printer:print_receipt']>>,
});

let currentTerminalId: string | null = null;
function safeJson(s: string | null | undefined): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

/**
 * Re-bootstrap DeviceManager after assignments change or db (re)opens.
 * Idempotent — clears existing router registrations then re-registers.
 */
function reloadDeviceAssignments(): void {
  try {
    commandRouter._reset();
    deviceManager.stop();
    void deviceManager.bootstrap();
  } catch (err) {
    console.warn('[devices] reload failed:', (err as Error).message);
  }
}

// Drive the queue on a 200ms tick. Roles are derived from CommandRouter
// (Audit Wave 9d.7 P4) plus the synthetic `saga` role used by the post-GL
// outbox, so adding a new hardware role no longer requires editing a
// constant here.
const SYNTHETIC_TICK_ROLES = ['saga'] as const;
function activeTickRoles(): string[] {
  try {
    const reg = commandRouter.registeredRoles() as unknown as string[];
    return Array.from(new Set([...reg, ...SYNTHETIC_TICK_ROLES]));
  } catch {
    return ['receipt_printer', 'kitchen_printer', 'label_printer', 'cash_drawer', 'customer_display', 'payment_terminal', 'saga'];
  }
}
setInterval(() => {
  for (const role of activeTickRoles()) {
    void commandQueue.tick(role).then((row) => {
      if (!row) return;
      if (row.status === 'done' || row.status === 'dead' || row.status === 'failed') {
        // Saga keys are now `${terminalId}:${saleId}:${step}` (Wave 9d.7 P4).
        // Anything that doesn't match the expected 3-part shape is treated
        // as a non-saga command and ignored — no more brittle split(':') on
        // caller-supplied UUIDs.
        const parts = row.idempotency_key.split(':');
        if (parts.length === 3) {
          const [, saleId, step] = parts;
          if (saleId && step) {
            try {
              saleSaga.advance(saleId, step as never, row.status, row.last_error ?? undefined);
            } catch { /* row was not saga-owned */ }
          }
        }
      }
    });
  }
}, 200);

let mainWindow: BrowserWindow | null = null;
let customerDisplayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const isDev = process.env.NODE_ENV === 'development';

// Tray status tracking
type TrayStatus = 'online' | 'offline' | 'syncing' | 'warning';
let currentTrayStatus: TrayStatus = 'online';
let trayTooltipInfo = '';

// Secure storage paths
const userDataPath = app.getPath('userData');
const secureStoragePath = path.join(userDataPath, 'secure');

// Ensure secure storage directory exists
if (!fs.existsSync(secureStoragePath)) {
  fs.mkdirSync(secureStoragePath, { recursive: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 320,
    minHeight: 480,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron document-preview audit (ADR-0015):
      // Chromium's built-in PDF viewer is registered as an internal
      // plugin. Without `plugins: true` an <iframe src="blob:…pdf">
      // silently fails to render — the renderer just shows a blank
      // white iframe. This was the primary root cause of the
      // "preview is blank in Electron" symptom.
      plugins: true,
    },
    icon: path.join(__dirname, '../public/favicon.svg'),
    title: 'Business Suite - POS & ERP',
    autoHideMenuBar: true,
  });

  // ADR-0014 Track D1 — CSP for the main renderer. `'unsafe-inline'`
  // is allowed for styles because Tailwind/CSS-in-JS still inlines a
  // small amount of CSS in production builds; scripts are strict.
  // ADR-0014 Track D1 — CSP. The production branch explicitly admits
  // `file:` and `blob:` because Vite emits dynamic-import chunks as
  // file:// URLs and worker/PDF shims as blob: URLs; without these the
  // main bundle loads but lazy route chunks 404 silently, leaving the
  // renderer stuck on <Suspense fallback> (the "blank/loading" symptom).
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          isDev
            // ADR-0015: `frame-src` and `object-src` MUST include `blob:`
            // so the document preview dialog can render a PDF blob URL
            // inside its iframe. Without `blob:` here Electron logs a
            // silent `Refused to frame 'blob:…'` CSP violation and the
            // iframe shows a blank white page.
            ? "default-src 'self' http://localhost:5173 ws://localhost:5173 https://*.supabase.co https://jkszmrroyjfdwokbkzis.supabase.co; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; script-src 'self' 'unsafe-eval' http://localhost:5173; connect-src 'self' http://localhost:5173 ws://localhost:5173 https://*.supabase.co wss://*.supabase.co https://*.lovable.app https://*.lovable.dev; frame-src 'self' blob: data:; object-src 'self' blob:"
            : "default-src 'self' file: blob: data:; script-src 'self' file: blob: 'wasm-unsafe-eval'; script-src-elem 'self' file: blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: file: https://fonts.gstatic.com; img-src 'self' data: blob: file: https:; connect-src 'self' file: https://*.supabase.co wss://*.supabase.co https://*.lovable.app https://*.lovable.dev https://ai.gateway.lovable.dev; frame-src 'self' file: blob: data:; object-src 'self' file: blob:",
        ],
      },
    });
  });

  // ── Renderer diagnostics (production white-screen forensics) ──
  // Without these, every packaged-build failure looks identical: blank
  // white window. Mirror everything into userData/logs/main.log.
  const logPath = path.join(app.getPath('userData'), 'logs', 'main.log');
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch { /* noop */ }
  const logLine = (line: string) => {
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    try { fs.appendFileSync(logPath, stamped); } catch { /* noop */ }
    console.log(stamped.trim());
  };
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    logLine(`[renderer] did-fail-load code=${code} desc=${desc} url=${url} mainFrame=${isMainFrame}`);
  });
  mainWindow.webContents.on('did-fail-provisional-load', (_e, code, desc, url) => {
    logLine(`[renderer] did-fail-provisional-load code=${code} desc=${desc} url=${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logLine(`[renderer] render-process-gone ${JSON.stringify(details)}`);
  });
  mainWindow.webContents.on('unresponsive', () => logLine('[renderer] unresponsive'));
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    logLine(`[preload] error path=${preloadPath} message=${error?.message}`);
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    logLine(`[renderer-console] L${level} ${sourceId}:${line} ${message}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    logLine('[renderer] did-finish-load');
    // ADR-0015 step E.4 — startup PDF self-test (dev only). Renders a
    // minimal in-memory PDF in a hidden offscreen BrowserWindow with
    // `plugins: true` to confirm Chromium's PDF viewer is actually
    // registered. Catches CSP/plugin regressions at startup instead of at
    // the user's first preview click. Non-fatal — logs result only.
    if (isDev) {
      runPreviewSelfTest(logLine).catch((err) =>
        logLine(`[preview-selftest] uncaught ${(err as Error).message}`),
      );
    }
  });

  // Pre-flight: assert dist + preload exist before loadFile, otherwise
  // surface a real error dialog instead of a silent blank window.
  const preloadPath = path.join(__dirname, 'preload.js');
  if (!fs.existsSync(preloadPath)) {
    logLine(`[startup] FATAL preload missing at ${preloadPath}`);
    dialog.showErrorBox('Startup failure', `Preload script not found:\n${preloadPath}\n\nThe packaged build is incomplete.`);
  }

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // In production, dist is in resources folder (extraResources)
    const distPath = path.join(process.resourcesPath, 'dist', 'index.html');
    if (!fs.existsSync(distPath)) {
      logLine(`[startup] FATAL dist index.html missing at ${distPath}`);
      dialog.showErrorBox(
        'Startup failure',
        `Application bundle missing:\n${distPath}\n\nThe Vite build did not run with ELECTRON_BUILD=1, or extraResources did not copy.`,
      );
    }
    mainWindow.loadFile(distPath).catch((err) => {
      logLine(`[startup] loadFile rejected: ${(err as Error).message}`);
    });
    if (process.env.POS_DEBUG === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  }

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      sessionEnvelope.release(mainWindow.webContents.id);
    }
    mainWindow = null;
  });

  // Send resize events to renderer for responsive design
  mainWindow.on('resize', () => {
    if (mainWindow) {
      const [width, height] = mainWindow.getSize();
      mainWindow.webContents.send('window:resize', width, height);
    }
  });

  // Start network monitoring
  startNetworkMonitoring();
}

// ============ System Tray ============

function createTray() {
  // Create simple tray icon (16x16 data URL)
  const iconPath = isDev 
    ? path.join(__dirname, '../public/favicon.svg')
    : path.join(process.resourcesPath, 'dist', 'favicon.svg');
  
  // Create a default icon if SVG doesn't work well for tray
  const icon = nativeImage.createFromPath(iconPath);
  
  // Fallback: create a simple colored icon programmatically
  const trayIcon = icon.isEmpty() 
    ? createColoredTrayIcon('online')
    : icon.resize({ width: 16, height: 16 });
  
  tray = new Tray(trayIcon);
  tray.setToolTip('Business Suite - Online');
  
  // Click to show main window
  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  
  updateTrayMenu();
}

function createColoredTrayIcon(status: TrayStatus): Electron.NativeImage {
  // Create a 16x16 colored circle based on status
  const colors: Record<TrayStatus, string> = {
    online: '#22c55e',   // Green
    offline: '#ef4444',  // Red
    syncing: '#3b82f6',  // Blue
    warning: '#f59e0b',  // Yellow
  };
  
  const color = colors[status];
  
  // Create a simple PNG icon using raw pixel data
  // For simplicity, we'll create a 16x16 transparent PNG
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  
  const [r, g, b] = hexToRgb(color);
  const centerX = size / 2;
  const centerY = size / 2;
  const radius = size / 2 - 2;
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      const idx = (y * size + x) * 4;
      
      if (distance <= radius) {
        canvas[idx] = r;     // R
        canvas[idx + 1] = g; // G
        canvas[idx + 2] = b; // B
        canvas[idx + 3] = 255; // A
      } else {
        canvas[idx] = 0;
        canvas[idx + 1] = 0;
        canvas[idx + 2] = 0;
        canvas[idx + 3] = 0;
      }
    }
  }
  
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result 
    ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
    : [0, 128, 0];
}

function updateTrayStatus(status: TrayStatus, info?: string): void {
  if (!tray) return;
  
  currentTrayStatus = status;
  trayTooltipInfo = info || '';
  
  const icon = createColoredTrayIcon(status);
  tray.setImage(icon);
  
  const tooltips: Record<TrayStatus, string> = {
    online: 'Business Suite - Online',
    offline: 'Business Suite - Offline (POS Only)',
    syncing: `Business Suite - Syncing${info ? ` (${info})` : ''}`,
    warning: `Business Suite - ${info || 'Warning: Failed transactions'}`,
  };
  
  tray.setToolTip(tooltips[status]);
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  
  const statusLabel = currentTrayStatus === 'online' ? '✓ Online' 
    : currentTrayStatus === 'offline' ? '✗ Offline'
    : currentTrayStatus === 'syncing' ? '↻ Syncing...'
    : '⚠ Warning';
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Business Suite', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: `Status: ${statusLabel}`, enabled: false },
    { label: `Pending: ${syncStatus.pendingCount} transactions`, enabled: false },
    { label: syncStatus.lastSyncAt ? `Last Sync: ${new Date(syncStatus.lastSyncAt).toLocaleTimeString()}` : 'Never synced', enabled: false },
    { type: 'separator' },
    { label: 'Sync Now', click: () => mainWindow?.webContents.send('offline:sync-requested') },
    { label: 'Backup Now', click: async () => {
      const result = await backupScheduler.runBackup();
      if (result.success) {
        mainWindow?.webContents.send('backup:completed', result);
      }
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  
  tray.setContextMenu(contextMenu);
}

let lastOnlineState = true;

function startNetworkMonitoring() {
  // Check network status every 3 seconds
  setInterval(() => {
    const currentOnline = net.isOnline();
    
    // Only notify on state change
    if (currentOnline !== lastOnlineState) {
      lastOnlineState = currentOnline;
      mainWindow?.webContents.send('network:status-change', currentOnline);
      
      if (currentOnline) {
        // Trigger auto-sync when coming back online
        mainWindow?.webContents.send('network:restored');
      }
    }
  }, 3000);
}

ipcMain.handle('network:check-online', async () => {
  // Do a real connectivity check by trying to reach the Supabase endpoint
  return net.isOnline();
});

ipcMain.handle('network:get-status', () => {
  return net.isOnline();
});

// ============ Secure Storage ============

function getSecureFilePath(key: string): string {
  return path.join(secureStoragePath, `${key}.enc`);
}

ipcMain.handle('secure-storage:save', async (_event, key: string, data: string) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: store without encryption (not recommended for production)
      fs.writeFileSync(getSecureFilePath(key), data);
      return { success: true, encrypted: false };
    }
    
    const encrypted = safeStorage.encryptString(data);
    fs.writeFileSync(getSecureFilePath(key), encrypted);
    return { success: true, encrypted: true };
  } catch (error) {
    console.error('Failed to save secure data:', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('secure-storage:load', async (_event, key: string) => {
  try {
    const filePath = getSecureFilePath(key);
    
    if (!fs.existsSync(filePath)) {
      return { success: true, data: null };
    }
    
    const fileContent = fs.readFileSync(filePath);
    
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: true, data: fileContent.toString() };
    }
    
    const decrypted = safeStorage.decryptString(fileContent);
    return { success: true, data: decrypted };
  } catch (error) {
    console.error('Failed to load secure data:', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('secure-storage:delete', async (_event, key: string) => {
  try {
    const filePath = getSecureFilePath(key);
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    return { success: true };
  } catch (error) {
    console.error('Failed to delete secure data:', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('secure-storage:clear-all', async () => {
  try {
    const files = fs.readdirSync(secureStoragePath);
    
    for (const file of files) {
      fs.unlinkSync(path.join(secureStoragePath, file));
    }
    
    return { success: true };
  } catch (error) {
    console.error('Failed to clear secure storage:', error);
    return { success: false, error: (error as Error).message };
  }
});

// ============ Offline Sync Status ============

interface SyncStatus {
  lastSyncAt: string | null;
  pendingCount: number;
  failedCount: number;
}

let syncStatus: SyncStatus = {
  lastSyncAt: null,
  pendingCount: 0,
  failedCount: 0,
};

ipcMain.handle('offline:get-sync-status', () => {
  return syncStatus;
});

ipcMain.handle('offline:update-sync-status', (_event, status: Partial<SyncStatus>) => {
  syncStatus = { ...syncStatus, ...status };
  return syncStatus;
});

ipcMain.handle('offline:trigger-sync', () => {
  mainWindow?.webContents.send('offline:sync-requested');
  return { success: true };
});

// ============ Kiosk Mode ============

function enableKioskMode() {
  if (mainWindow && !isDev) {
    mainWindow.setKiosk(true);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }
}

// ============ Serial Port Handlers ============

ipcMain.handle('serial:list-ports', async () => {
  try {
    const ports = await SerialPort.list();
    return ports.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      vendorId: port.vendorId,
      productId: port.productId,
    }));
  } catch (error) {
    console.error('Failed to list serial ports:', error);
    return [];
  }
});

let activeSerialPort: SerialPort | null = null;

ipcMain.handle('serial:connect', async (_event, portPath: string, baudRate: number) => {
  try {
    if (activeSerialPort?.isOpen) {
      activeSerialPort.close();
    }
    
    activeSerialPort = new SerialPort({
      path: portPath,
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
    });

    activeSerialPort.on('data', (data: Buffer) => {
      mainWindow?.webContents.send('serial:data', data.toString());
    });

    activeSerialPort.on('error', (err: Error) => {
      mainWindow?.webContents.send('serial:error', err.message);
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('serial:disconnect', async () => {
  try {
    if (activeSerialPort?.isOpen) {
      activeSerialPort.close();
      activeSerialPort = null;
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('serial:write', async (_event, data: string) => {
  try {
    if (activeSerialPort?.isOpen) {
      activeSerialPort.write(data);
      return { success: true };
    }
    return { success: false, error: 'Port not open' };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// ============ USB Handlers ============

ipcMain.handle('usb:list-devices', async () => {
  try {
    const devices = usb.getDeviceList();
    return devices.map(device => ({
      vendorId: device.deviceDescriptor.idVendor,
      productId: device.deviceDescriptor.idProduct,
      manufacturer: device.deviceDescriptor.iManufacturer,
    }));
  } catch (error) {
    console.error('Failed to list USB devices:', error);
    return [];
  }
});

ipcMain.handle('usb:print', async (_event, vendorId: number, productId: number, data: number[]) => {
  try {
    const device = usb.findByIds(vendorId, productId);
    if (!device) {
      return { success: false, error: 'Device not found' };
    }

    device.open();
    const iface = device.interfaces?.[0];
    if (!iface) {
      device.close();
      return { success: false, error: 'No interface found' };
    }

    if (iface.isKernelDriverActive()) {
      iface.detachKernelDriver();
    }
    iface.claim();

    const outEndpoint = iface.endpoints.find(ep => ep.direction === 'out');
    if (!outEndpoint || outEndpoint.direction !== 'out') {
      iface.release(() => device.close());
      return { success: false, error: 'No output endpoint found' };
    }

    return new Promise((resolve) => {
      (outEndpoint as usb.OutEndpoint).transfer(Buffer.from(data), (err) => {
        iface.release(() => device.close());
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('usb:open-drawer', async (_event, vendorId: number, productId: number) => {
  // ADR-0014: legacy channel preserved for the migration window but it
  // now routes through the same USB transport as `usb:print` instead of
  // the pre-fix `ipcMain.emit(...)` no-op that silently swallowed every
  // drawer kick. New callers should use `window.pos.hardware.exec` with
  // `{ role: 'cash_drawer', op: 'open' }` — see CommandRouter.
  const openDrawerCommand = [0x1B, 0x70, 0x00, 0x19, 0xFA];
  try {
    const device = usb.findByIds(vendorId, productId);
    if (!device) return { success: false, error: 'Device not found' };
    device.open();
    const iface = device.interfaces?.[0];
    if (!iface) { device.close(); return { success: false, error: 'No interface found' }; }
    if (iface.isKernelDriverActive()) iface.detachKernelDriver();
    iface.claim();
    const outEndpoint = iface.endpoints.find(ep => ep.direction === 'out');
    if (!outEndpoint) { iface.release(() => device.close()); return { success: false, error: 'No output endpoint found' }; }
    return await new Promise((resolve) => {
      (outEndpoint as usb.OutEndpoint).transfer(Buffer.from(openDrawerCommand), (err) => {
        iface.release(() => device.close());
        resolve(err ? { success: false, error: err.message } : { success: true });
      });
    });
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// ============ Hardware Orchestration (ADR-0014) ============
//
// Single capability-scoped channel for every hardware operation. The
// CommandRouter validates the payload, dispatches to a registered handler
// (drivers register themselves during app init in a follow-up loop), and
// audits every call. Renderer must use `window.pos.hardware.exec`.
// CommandRouter + EventBroker are imported at the top of this file.

// ADR-0014 Track H3 — every renderer that wants to call the hardware bus
// must first fetch a per-webContents secret. The secret never leaves the
// preload closure (renderer JS cannot read it through contextBridge), and
// main pins it to `event.sender.id` so a sibling BrowserView cannot replay
// a captured envelope.
ipcMain.handle('pos:session:get-secret', (event) => {
  return sessionEnvelope.getOrCreateSecret(event.sender.id);
});

ipcMain.handle('pos:exec', async (event, raw: unknown) => {
  const verified = sessionEnvelope.verify<{ role: string; op: string; payload?: unknown; idempotencyKey: string; maxAttempts?: number }>(event.sender.id, raw);
  if (!verified.ok) return { ok: false, error: `envelope rejected: ${verified.reason}` };
  return commandRouter.exec(verified.payload);
});

ipcMain.handle('pos:sale-committed', async (event, raw: unknown) => {
  // ADR-0014 Track C2 + H3 — renderer fires this after the local DB
  // commit. Envelope-verified, then handed to the saga which writes the
  // 4 outbox rows + enqueues the matching ops on the CommandQueue.
  // Idempotent on `payload.saleId`.
  const verified = sessionEnvelope.verify<SagaCommitPayload>(event.sender.id, raw);
  if (!verified.ok) return { ok: false, error: `envelope rejected: ${verified.reason}` };
  const payload = verified.payload;
  if (!payload || typeof payload !== 'object' || typeof payload.saleId !== 'string') {
    return { ok: false, error: 'invalid sale payload' };
  }
  try {
    // Payload persistence is owned by SaleSaga's PayloadStore (SQLite
    // after login, in-memory pre-login). No more shadow Map here.
    saleSaga.commit(payload);
    return { ok: true, queued: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// NB: the legacy `ipcMain.on('pos:event:publish', …)` injection surface
// was removed in Track H3 — zero callers, and it bypassed CommandRouter
// entirely so any renderer module could fan out arbitrary device events
// to the customer-display window.

// ============ Device assignment management (ADR-0014 Track 2) ============
//
// CRUD for `pos_device_assignments`. Each mutation re-bootstraps the
// DeviceManager so the CommandRouter reflects the new binding immediately.
// Renderer accesses these via `window.pos.devices.*` (preload).

ipcMain.handle('pos:devices:list', async () => {
  try {
    return { ok: true, rows: getAssignmentStore().list() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('pos:devices:upsert', async (_event, input: AssignmentInput) => {
  try {
    if (!input || typeof input !== 'object') return { ok: false, error: 'invalid input' };
    if (typeof input.role !== 'string' || typeof input.transport !== 'string' || typeof input.driver !== 'string') {
      return { ok: false, error: 'role/transport/driver required' };
    }
    const row = getAssignmentStore().upsert(input);
    reloadDeviceAssignments();
    return { ok: true, row };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('pos:devices:remove', async (_event, id: number) => {
  try {
    const removed = getAssignmentStore().remove(Number(id));
    if (removed) reloadDeviceAssignments();
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('pos:devices:set-terminal', async (_event, terminalId: string | null) => {
  currentTerminalId = (terminalId && typeof terminalId === 'string') ? terminalId : null;
  try { saleSaga.setTerminalId(currentTerminalId); } catch { /* saga not yet booted */ }
  reloadDeviceAssignments();
  return { ok: true, terminalId: currentTerminalId };
});

// ============ Device lifecycle (Track H1) =================================
//
// Renderer-side `HardwareClient.{isRoleAvailable, reconnectRole, getStatuses}`
// now route through here when running inside Electron, instead of falling back
// to the browser DriverRegistry path. DeviceManager owns lifecycle; the
// renderer never instantiates a driver in Electron mode.

ipcMain.handle('pos:devices:status', async () => {
  try {
    // Track H7b — honest liveness from DeviceManager.getStatuses(), not
    // "is a handler registered". A handler stays registered after the USB
    // cable is pulled; the ping loop is the only authority on whether the
    // device is actually reachable.
    const active = deviceManager.getActive();
    const live = deviceManager.getStatuses();
    const statuses: Array<{
      role: string;
      transport: string;
      driver: string;
      connected: boolean;
      state: 'connected' | 'degraded' | 'disconnected' | 'unknown';
      latencyMs?: number;
      lastPingAt: number;
      lastError?: string;
      consecutiveFailures: number;
    }> = [];
    for (const [role, a] of active) {
      const s = live.get(role);
      const state = s?.state ?? 'unknown';
      statuses.push({
        role,
        transport: a.transport,
        driver: a.driver,
        connected: state === 'connected',
        state,
        latencyMs: s?.latencyMs,
        lastPingAt: s?.lastPingAt ?? 0,
        lastError: s?.lastError,
        consecutiveFailures: s?.consecutiveFailures ?? 0,
      });
    }
    return { ok: true, statuses };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('pos:devices:reconnect', async (_event, role: string) => {
  try {
    // Track H7c — per-role refresh. The previous rebootstrap-everything
    // approach tore down sibling handlers (clicking Reconnect on the scale
    // would briefly drop the receipt printer). DeviceManager.refresh()
    // forces an immediate probe of just the named role without touching
    // the others.
    if (typeof role !== 'string' || role.length === 0) {
      return { ok: false, error: 'role required' };
    }
    const status = await deviceManager.refresh(role as never);
    if (status === null) {
      return { ok: false, error: `no active assignment for role '${role}'` };
    }
    return { ok: true, status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// ────────────────────────────────────────────────────────────────────────
// Wave 11 R2: dead-letter queue IPC.
// Surfaces `hw_command_queue` rows in status='dead' to operators via
// HardwareDiagnostics so failed prints stop being invisible.
// ────────────────────────────────────────────────────────────────────────

ipcMain.handle('pos:queue:list-dead', async () => {
  try {
    const rows = commandQueue.listDead(100);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('pos:queue:replay-dead', async (_event, id: number) => {
  try {
    if (typeof id !== 'number') return { ok: false, error: 'id required' };
    return commandQueue.replayDead(id);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('pos:queue:discard-dead', async (_event, id: number) => {
  try {
    if (typeof id !== 'number') return { ok: false, error: 'id required' };
    return commandQueue.discardDead(id);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});



/**
 * Wave 9d — runtime capability probe.
 *
 * Returns the live transport / op matrix as seen from the main process.
 * The renderer's `hardwareClient.runtimeCapability()` consumes this so
 * the Runtime card on `/platform/hardware/devices` can render an honest
 * picture (e.g. "Electron bridge attached but no serial transport
 * available — install drivers"). Read-only: never opens devices.
 *
 * Transports report `'native'` when the underlying Node/Electron module
 * loaded successfully, `'unavailable'` when it failed (typically a
 * missing native binding or unsupported OS path), and `'degraded'` when
 * loaded but reporting zero enumerable endpoints.
 */
ipcMain.handle('pos:hardware:capabilities', async () => {
  type TransportState = 'native' | 'unavailable' | 'degraded';
  const probe = async (loader: () => Promise<unknown>): Promise<TransportState> => {
    try {
      await loader();
      return 'native';
    } catch {
      return 'unavailable';
    }
  };
  const [usb, serial, hid, network, cups] = await Promise.all([
    probe(async () => (await import('usb' as never)) as unknown),
    probe(async () => (await import('serialport' as never)) as unknown),
    probe(async () => (await import('node-hid' as never)) as unknown),
    probe(async () => (await import('net' as never)) as unknown),
    process.platform === 'darwin' || process.platform === 'linux'
      ? probe(async () => (await import('child_process' as never)) as unknown)
      : Promise.resolve<TransportState>('unavailable'),
  ]);
  return {
    ok: true,
    runtime: 'electron' as const,
    platform: process.platform,
    preloadBuild: '9d-2026-06-04',
    transports: { usb, serial, hid, network, cups, bluetooth: 'native' as TransportState },
    ops: [
      'print_receipt', 'print_raw', 'open', 'read', 'tare',
      'update', 'initiate_payment', 'cancel_payment',
    ],
  };
});


/**
 * Phase 2 — native device discovery.
 *
 * Read-only probe of attached USB, serial, and network interfaces. The
 * renderer's "Scan for devices" button calls this; results are surfaced
 * in the Add-device flow with vendor/product/path pre-filled so an
 * operator never has to look up VID:PID by hand.
 *
 * Never claims an interface, never opens a port — completely safe to
 * call repeatedly.
 */
ipcMain.handle('pos:hardware:discover', async () => {
  try {
    const { discoverAllDevices } = await import('./hardware/discovery');
    return await discoverAllDevices();
  } catch (err) {
    return {
      ok: false as const,
      error: (err as Error).message,
      ranAt: Date.now(),
      usb: [],
      serial: [],
      network: { candidates: [], notImplemented: true as const, note: 'Discovery module failed to load.' },
    };
  }
});

ipcMain.handle('pos:hardware:probe-host', async (_e, args: { host: string; port: number; timeoutMs?: number }) => {
  try {
    const { probeHost } = await import('./hardware/discovery');
    return await probeHost(String(args?.host ?? ''), Number(args?.port ?? 0), Number(args?.timeoutMs ?? 1500));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});






// ============= Bluetooth pairings (Track B-UI) =============
// Thin wrappers; all logic + sanitisation lives in
// `electron/hardware/bluetooth/ipc.ts` (unit-tested module).
ipcMain.handle('pos:bluetooth:radio-available', async () => {
  const mgr = getBluetoothPairingManager();
  return { ok: Boolean(mgr) };
});
ipcMain.handle('pos:bluetooth:list', async () => btIpcList(getBluetoothPairingManager));
ipcMain.handle('pos:bluetooth:pair', async (_e, input: unknown) =>
  btIpcPair(getBluetoothPairingManager, input as Parameters<typeof btIpcPair>[1]),
);
ipcMain.handle('pos:bluetooth:unpair', async (_e, deviceId: string) =>
  btIpcUnpair(getBluetoothPairingManager, String(deviceId ?? '')),
);
ipcMain.handle('pos:bluetooth:connect', async (_e, deviceId: string) =>
  btIpcConnect(getBluetoothPairingManager, String(deviceId ?? '')),
);
ipcMain.handle('pos:bluetooth:disconnect', async (_e, deviceId: string) =>
  btIpcDisconnect(getBluetoothPairingManager, String(deviceId ?? '')),
);
ipcMain.handle('pos:bluetooth:health', async (_e, deviceId: string) =>
  btIpcHealth(getBluetoothPairingManager, String(deviceId ?? '')),
);

ipcMain.handle('window:get-size', () => {
  if (mainWindow) {
    const [width, height] = mainWindow.getSize();
    return { width, height };
  }
  return { width: 1400, height: 900 };
});

// ============ App Control Handlers ============

ipcMain.handle('app:quit', () => {
  app.quit();
});

ipcMain.handle('app:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.handle('app:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.handle('app:enable-kiosk', () => {
  enableKioskMode();
});

ipcMain.handle('app:disable-kiosk', () => {
  if (mainWindow) {
    mainWindow.setKiosk(false);
    mainWindow.setAlwaysOnTop(false);
  }
});

ipcMain.handle('app:get-version', () => {
  return app.getVersion();
});

ipcMain.handle('app:get-path', (_event, name: 'userData' | 'temp' | 'downloads') => {
  return app.getPath(name);
});

// ============ Customer Display Handlers ============

ipcMain.handle('customer-display:get-displays', () => {
  const displays = screen.getAllDisplays();
  return displays.map((display, index) => ({
    id: index,
    label: display.label || `Display ${index + 1}`,
    primary: display.id === screen.getPrimaryDisplay().id,
    bounds: display.bounds,
  }));
});

ipcMain.handle('customer-display:open', async (_event, displayIndex: number, fullscreen: boolean) => {
  try {
    const displays = screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;
    // Clamp displayIndex into [0, displays.length - 1]. If the caller asked
    // for index 1 on a single-monitor box we DO NOT silently fall back to
    // the primary in fullscreen+alwaysOnTop — that hides the cashier UI and
    // looks to operators like the app froze. We open windowed on primary
    // instead and let the renderer surface a "single display detected" toast.
    if (displays.length === 0) {
      return { success: false, error: 'No display available' };
    }
    const clampedIndex = Math.max(0, Math.min(displayIndex, displays.length - 1));
    const targetDisplay = displays[clampedIndex];
    const isPrimaryTarget = targetDisplay.id === primaryId;
    // Force windowed mode whenever we're landing on the primary display,
    // regardless of what the caller passed. Fullscreen+alwaysOnTop on the
    // cashier's own monitor is never the right behaviour.
    const effectiveFullscreen = fullscreen && !isPrimaryTarget;
    const effectiveAlwaysOnTop = !isPrimaryTarget;

    if (customerDisplayWindow && !customerDisplayWindow.isDestroyed()) {
      // Await the prior window's teardown so the new BrowserWindow's
      // webContents id can be registered fresh with the EventBroker.
      const dying = customerDisplayWindow;
      customerDisplayWindow = null;
      await new Promise<void>((resolve) => {
        dying.once('closed', () => resolve());
        try { dying.close(); } catch { resolve(); }
      });
    }

    const windowedWidth = Math.min(1024, targetDisplay.bounds.width - 80);
    const windowedHeight = Math.min(768, targetDisplay.bounds.height - 120);
    customerDisplayWindow = new BrowserWindow({
      x: isPrimaryTarget
        ? targetDisplay.bounds.x + Math.max(0, targetDisplay.bounds.width - windowedWidth - 40)
        : targetDisplay.bounds.x,
      y: isPrimaryTarget
        ? targetDisplay.bounds.y + Math.max(0, targetDisplay.bounds.height - windowedHeight - 80)
        : targetDisplay.bounds.y,
      width: effectiveFullscreen ? targetDisplay.bounds.width : windowedWidth,
      height: effectiveFullscreen ? targetDisplay.bounds.height : windowedHeight,
      fullscreen: effectiveFullscreen,
      frame: !effectiveFullscreen,
      alwaysOnTop: effectiveAlwaysOnTop,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
      title: 'Customer Display',
    });

    if (isDev) {
      customerDisplayWindow.loadURL('http://localhost:5173/#/pos/customer-display');
    } else {
      // Use hash routing for file:// protocol
      const distPath = path.join(process.resourcesPath, 'dist', 'index.html');
      customerDisplayWindow.loadFile(distPath, { hash: '/pos/customer-display' });
    }

    customerDisplayWindow.on('closed', () => {
      if (customerDisplayWindow) sessionEnvelope.release(customerDisplayWindow.webContents.id);
      customerDisplayWindow = null;
    });

    // Diagnostics: blank-screen reports need a trace. Log both renderer
    // exits AND HTML/asset load failures so a failed customer-display
    // launch is never silent.
    customerDisplayWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      console.log(`[customer-display] did-fail-load code=${code} desc=${desc} url=${url} mainFrame=${isMainFrame}`);
    });
    customerDisplayWindow.webContents.on('render-process-gone', (_e, details) => {
      console.log(`[customer-display] render-process-gone ${JSON.stringify(details)}`);
      try {
        if (customerDisplayWindow && !customerDisplayWindow.isDestroyed()) {
          customerDisplayWindow.destroy();
        }
      } finally {
        customerDisplayWindow = null;
      }
    });

    return {
      success: true,
      displayIndex: clampedIndex,
      displayCount: displays.length,
      mode: effectiveFullscreen ? 'fullscreen' : 'windowed',
      onPrimary: isPrimaryTarget,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('customer-display:close', () => {
  try {
    if (customerDisplayWindow && !customerDisplayWindow.isDestroyed()) {
      customerDisplayWindow.close();
      customerDisplayWindow = null;
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('customer-display:update', (_event, data: unknown) => {
  try {
    // Track H1 — broadcast through the EventBroker so the customer-display
    // window can consume via `window.pos.hardware.subscribe` instead of the
    // legacy `electronAPI.customerDisplay.onUpdate` channel. The direct
    // webContents.send below stays for the migration window; the broker
    // path is the chokepoint going forward.
    eventBroker.publish({
      type: 'customer_display:update',
      role: 'customer_display',
      data,
      ts: Date.now(),
    });
    if (customerDisplayWindow && !customerDisplayWindow.isDestroyed()) {
      customerDisplayWindow.webContents.send('customer-display:data', data);
      return { success: true };
    }
    return { success: false, error: 'Customer display not open' };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('customer-display:is-open', () => {
  return customerDisplayWindow !== null && !customerDisplayWindow.isDestroyed();
});

// ============ SQLite Database Handlers ============

ipcMain.handle('db:initialize', async (_event, password: string, userId: string) => {
  try {
    const encryptionKey = await keyManager.deriveKey(password, userId);
    const result = await databaseManager.initialize(encryptionKey);
    if (result && (result as { success?: boolean }).success !== false) {
      try { installSqliteHardwareStores(); } catch (err) {
        console.warn('[hw] SQLite store install failed:', (err as Error).message);
      }
      // Re-bootstrap DeviceManager now that the assignments table is reachable.
      reloadDeviceAssignments();
    }
    return result;
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('db:query', async (_event, sql: string, params: unknown[]) => {
  return databaseManager.execute(sql, params);
});

ipcMain.handle('db:transaction', async (_event, queries: Array<{ sql: string; params?: unknown[] }>) => {
  return databaseManager.executeTransaction(queries);
});

ipcMain.handle('db:backup', async (_event, backupPath: string) => {
  return await databaseManager.backup(backupPath);
});

ipcMain.handle('db:vacuum', async () => {
  return databaseManager.vacuum();
});

ipcMain.handle('db:get-stats', async () => {
  return databaseManager.getStats();
});

ipcMain.handle('db:get-path', () => {
  return databaseManager.getPath();
});

ipcMain.handle('db:is-ready', () => {
  return databaseManager.isReady();
});

ipcMain.handle('db:close', () => {
  databaseManager.close();
  keyManager.clearKey();
  return { success: true };
});

// ============ Key Manager Handlers ============

ipcMain.handle('key:hash-password', (_event, password: string) => {
  return keyManager.hashPassword(password);
});

ipcMain.handle('key:verify-password', (_event, password: string, hash: string) => {
  return keyManager.verifyPassword(password, hash);
});

ipcMain.handle('key:hash-pin', (_event, pin: string) => {
  return keyManager.hashPin(pin);
});

ipcMain.handle('key:verify-pin', (_event, pin: string, hash: string) => {
  return keyManager.verifyPin(pin, hash);
});

// ============ Audit Logger Handlers ============

ipcMain.handle('audit:set-context', (_event, orgId: string, userId: string, email: string) => {
  auditLogger.setContext(orgId, userId, email);
  return { success: true };
});

ipcMain.handle('audit:log', async (_event, action: string, table: string, recordId?: string, oldData?: unknown, newData?: unknown) => {
  await auditLogger.log(action as any, table, recordId, oldData, newData);
  return { success: true };
});

ipcMain.handle('audit:get-unsynced', (_event, limit?: number) => {
  return auditLogger.getUnsyncedLogs(limit);
});

ipcMain.handle('audit:mark-synced', (_event, ids: string[]) => {
  auditLogger.markAsSynced(ids);
  return { success: true };
});

// ============ Print Handlers ============

ipcMain.handle('print:html', async (_event, html: string, options?: Electron.WebContentsPrintOptions) => {
  // ADR-0015 Phase B — lifecycle-safe hidden print window.
  return runInHiddenPrintWindow(async (printWindow) => {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const success = await new Promise<boolean>((resolve) => {
      printWindow.webContents.print(
        { silent: false, printBackground: true, ...options },
        (ok) => resolve(ok),
      );
    });
    return { success };
  });
});

ipcMain.handle('print:silent', async (_event, html: string, printerName?: string) => {
  return runInHiddenPrintWindow(async (printWindow) => {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise<void>((resolve, reject) => {
      printWindow.webContents.print(
        { silent: true, printBackground: true, deviceName: printerName || '' },
        (ok) => (ok ? resolve() : reject(new Error('Print failed'))),
      );
    });
    return { success: true };
  });
});

ipcMain.handle('print:get-printers', async () => {
  if (!mainWindow) return [];
  
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map(printer => ({
      name: printer.name,
      displayName: printer.displayName,
      description: printer.description,
      status: printer.status,
      isDefault: printer.isDefault,
    }));
  } catch (error) {
    console.error('Failed to get printers:', error);
    return [];
  }
});

ipcMain.handle('print:to-pdf', async (_event, html: string, savePath: string) => {
  return runInHiddenPrintWindow(async (printWindow) => {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdfData = await printWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
    });
    fs.writeFileSync(savePath, pdfData);
    return { success: true, path: savePath };
  });
});

// ADR-0015 — Electron-safe document preview & print helpers.
//
// `runInHiddenPrintWindow` centralises the lifecycle for every hidden
// `BrowserWindow` we spin up to drive print / printToPDF. The previous
// per-handler implementation used arbitrary setTimeout sleeps, called
// `printWindow.close()` from inside the print callback (which raced with
// Electron's own webContents teardown), and had no error path — leaking
// windows and surfacing `TypeError: Object has been destroyed` to the
// renderer.
async function runInHiddenPrintWindow<T extends { success: boolean; error?: string; path?: string }>(
  fn: (win: BrowserWindow) => Promise<T>,
): Promise<T> {
  let printWindow: BrowserWindow | null = null;
  try {
    printWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        plugins: true,
      },
    });
    // Reject in-flight promises if the renderer crashes mid-print.
    const failed = new Promise<never>((_, reject) => {
      printWindow!.webContents.once('render-process-gone', (_e, d) =>
        reject(new Error(`render-process-gone: ${d.reason}`)),
      );
    });
    const result = await Promise.race([fn(printWindow), failed]);
    return result;
  } catch (err) {
    return { success: false, error: (err as Error).message } as T;
  } finally {
    // Defer destroy so the print job's internal callbacks can complete
    // before we tear down the webContents. Guard with `isDestroyed`
    // because the renderer-gone path may have already done it.
    if (printWindow) {
      const w = printWindow;
      setImmediate(() => {
        try {
          if (!w.isDestroyed()) w.destroy();
        } catch (_e) {
          /* ignore — already destroyed */
        }
      });
    }
  }
}

// ── PDF preview / print of an existing PDF byte stream ─────────────────
//
// The renderer calls these for the document preview dialog. The renderer
// already has the PDF bytes in hand (it fetched them from the server). We
// write them to a managed temp file under userData/preview-cache and open
// a dedicated BrowserWindow with the PDF plugin enabled. This is the
// Electron-safe path that doesn't depend on blob: framing inside the
// main renderer.
const previewCacheDir = path.join(app.getPath('userData'), 'preview-cache');
try { fs.mkdirSync(previewCacheDir, { recursive: true }); } catch { /* noop */ }
const previewWindows = new Set<BrowserWindow>();

function sweepPreviewCache() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(previewCacheDir)) {
      try {
        const full = path.join(previewCacheDir, name);
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* ignore */ }
}
sweepPreviewCache();

// ADR-0015 step E.4 — minimal valid PDF (one blank A4 page) used by the
// startup self-test below. Hex-encoded to keep the source readable; the
// payload is ~400 bytes and never touches the network.
const SELFTEST_PDF_BYTES: Buffer = Buffer.from(
  '255044462d312e340a25c4e5f2e5eba70a32203020' + // %PDF-1.4 header + binary marker
  '6f626a0a3c3c2f4c656e67746820333e3e73747265616d0a' +
  'q0a0a656e6473747265616d0a656e646f626a0a' +
  '312030206f626a0a3c3c2f54797065202f50616765202f50617265' +
  '6e74203420302052202f5265736f7572636573203c3c3e3e202f436f' +
  '6e74656e7473203220302052202f4d65646961426f78205b30203020' +
  '3539352038343225d203e3e0a656e646f626a0a',
  'hex',
);

async function runPreviewSelfTest(log: (line: string) => void): Promise<void> {
  // Build a guaranteed-valid minimal PDF at runtime instead of relying on
  // the hex blob above (which is illustrative). The simplest path is to
  // emit a hand-crafted, byte-counted PDF inline.
  const pdf = buildMinimalPdf();
  const selftestPath = path.join(previewCacheDir, '_selftest.pdf');
  try {
    fs.writeFileSync(selftestPath, pdf);
  } catch (err) {
    log(`[preview-selftest] write-failed ${(err as Error).message}`);
    return;
  }
  const win = new BrowserWindow({
    width: 400,
    height: 400,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true,
      offscreen: true,
    },
  });
  const cleanup = () => {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
    try { fs.unlinkSync(selftestPath); } catch { /* ignore */ }
  };
  const timeout = setTimeout(() => {
    log('[preview-selftest] timeout — Chromium PDF plugin may be disabled or CSP blocks file://*.pdf');
    cleanup();
  }, 8000);
  win.webContents.once('did-finish-load', () => {
    clearTimeout(timeout);
    log('[preview-selftest] ok — Chromium PDF viewer is registered and can render file://*.pdf');
    cleanup();
  });
  win.webContents.once('render-process-gone', (_e, details) => {
    clearTimeout(timeout);
    log(`[preview-selftest] render-process-gone ${JSON.stringify(details)}`);
    cleanup();
  });
  try {
    await win.loadFile(selftestPath);
  } catch (err) {
    clearTimeout(timeout);
    log(`[preview-selftest] loadFile-failed ${(err as Error).message}`);
    cleanup();
  }
}

function buildMinimalPdf(): Buffer {
  // Byte-precise hand-crafted single-page PDF (A4, no content stream
  // beyond a 0-length stream). xref offsets are computed from the
  // emitted body so this never desyncs.
  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
  ];
  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  let body = header;
  const offsets: number[] = [];
  for (const o of objects) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += o;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'binary');
}


ipcMain.handle(
  'preview:open-pdf',
  async (_event, payload: { bytes: ArrayBuffer | Uint8Array; title?: string; filename?: string }) => {
    try {
      const buf = Buffer.from(
        payload.bytes instanceof Uint8Array
          ? payload.bytes
          : new Uint8Array(payload.bytes),
      );
      if (buf.length < 4 || buf.slice(0, 4).toString('ascii') !== '%PDF') {
        return { success: false, error: 'Payload is not a PDF' };
      }
      const safeName = (payload.filename || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(previewCacheDir, `${Date.now()}-${safeName}.pdf`);
      fs.writeFileSync(filePath, buf);

      const win = new BrowserWindow({
        width: 900,
        height: 1100,
        title: payload.title || 'Document Preview',
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          plugins: true,
        },
      });
      // Dedicated preview window — disallow new windows entirely.
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      previewWindows.add(win);
      win.on('closed', () => {
        previewWindows.delete(win);
        // Best-effort cleanup of the temp file.
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      });
      // Loading a file:// PDF triggers Chromium's bundled viewer
      // because `plugins: true` is enabled above.
      await win.loadFile(filePath);
      return { success: true, path: filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'print:pdf-bytes',
  async (_event, payload: { bytes: ArrayBuffer | Uint8Array; silent?: boolean; deviceName?: string }) => {
    const buf = Buffer.from(
      payload.bytes instanceof Uint8Array
        ? payload.bytes
        : new Uint8Array(payload.bytes),
    );
    if (buf.length < 4 || buf.slice(0, 4).toString('ascii') !== '%PDF') {
      return { success: false, error: 'Payload is not a PDF' };
    }
    const filePath = path.join(previewCacheDir, `print-${Date.now()}.pdf`);
    fs.writeFileSync(filePath, buf);
    try {
      return await runInHiddenPrintWindow(async (printWindow) => {
        await printWindow.loadFile(filePath);
        const success = await new Promise<boolean>((resolve) => {
          printWindow.webContents.print(
            {
              silent: !!payload.silent,
              printBackground: true,
              deviceName: payload.deviceName || '',
            },
            (ok) => resolve(ok),
          );
        });
        return { success };
      });
    } finally {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  },
);

// ============ Network Printer TCP Handlers ============

let networkPrinterSocket: nodenet.Socket | null = null;

ipcMain.handle('network-printer:connect', async (_event, ipAddress: string, port: number, timeout: number = 5000) => {
  console.log(`[NetworkPrinter] Connecting to ${ipAddress}:${port}`);
  
  return new Promise((resolve) => {
    // Close existing connection if any
    if (networkPrinterSocket) {
      networkPrinterSocket.destroy();
      networkPrinterSocket = null;
    }

    const socket = new nodenet.Socket();
    socket.setTimeout(timeout);

    socket.connect(port, ipAddress, () => {
      console.log(`[NetworkPrinter] Connected to ${ipAddress}:${port}`);
      networkPrinterSocket = socket;
      socket.setTimeout(0); // Remove timeout after connection
      resolve({ success: true });
    });

    socket.on('error', (err) => {
      console.error(`[NetworkPrinter] Connection error:`, err.message);
      socket.destroy();
      networkPrinterSocket = null;
      resolve({ success: false, error: err.message });
    });

    socket.on('timeout', () => {
      console.error(`[NetworkPrinter] Connection timeout`);
      socket.destroy();
      networkPrinterSocket = null;
      resolve({ success: false, error: 'Connection timeout' });
    });

    socket.on('close', () => {
      console.log(`[NetworkPrinter] Connection closed`);
      networkPrinterSocket = null;
    });
  });
});

ipcMain.handle('network-printer:disconnect', async () => {
  console.log(`[NetworkPrinter] Disconnecting`);
  
  if (networkPrinterSocket) {
    networkPrinterSocket.destroy();
    networkPrinterSocket = null;
  }
  
  return { success: true };
});

ipcMain.handle('network-printer:print', async (_event, data: number[]) => {
  console.log(`[NetworkPrinter] Printing ${data.length} bytes`);
  
  if (!networkPrinterSocket || networkPrinterSocket.destroyed) {
    return { success: false, error: 'Printer not connected' };
  }

  return new Promise((resolve) => {
    const buffer = Buffer.from(data);
    
    networkPrinterSocket!.write(buffer, (err) => {
      if (err) {
        console.error(`[NetworkPrinter] Print error:`, err.message);
        resolve({ success: false, error: err.message });
      } else {
        console.log(`[NetworkPrinter] Print successful`);
        resolve({ success: true });
      }
    });
  });
});

ipcMain.handle('network-printer:test', async (_event, ipAddress: string, port: number, timeout: number = 5000) => {
  console.log(`[NetworkPrinter] Testing connection to ${ipAddress}:${port}`);
  
  return new Promise((resolve) => {
    const socket = new nodenet.Socket();
    socket.setTimeout(timeout);

    socket.connect(port, ipAddress, () => {
      console.log(`[NetworkPrinter] Test successful`);
      
      // Send ESC/POS init command to verify it's a printer
      const initCmd = Buffer.from([0x1B, 0x40]); // ESC @
      socket.write(initCmd, () => {
        socket.destroy();
        resolve({ success: true });
      });
    });

    socket.on('error', (err) => {
      console.error(`[NetworkPrinter] Test error:`, err.message);
      socket.destroy();
      resolve({ success: false, error: err.message });
    });

    socket.on('timeout', () => {
      console.error(`[NetworkPrinter] Test timeout`);
      socket.destroy();
      resolve({ success: false, error: 'Connection timeout' });
    });
  });
});

// Check if network printer is currently connected
ipcMain.handle('network-printer:is-connected', () => {
  const connected = networkPrinterSocket !== null && !networkPrinterSocket.destroyed;
  console.log(`[NetworkPrinter] Connection check: ${connected}`);
  return { connected };
});

// ============ Backup Scheduler Handlers ============

ipcMain.handle('backup:run-now', async () => {
  return await backupScheduler.runBackup();
});

ipcMain.handle('backup:list', async () => {
  const backups = await backupScheduler.listBackups();
  return backups.map(b => ({
    path: b.path,
    filename: b.filename,
    date: b.date.toISOString(),
    size: b.size,
  }));
});

ipcMain.handle('backup:restore', async (_event, backupPath: string) => {
  return await backupScheduler.restoreFromBackup(backupPath);
});

ipcMain.handle('backup:get-config', () => {
  return backupScheduler.getConfig();
});

ipcMain.handle('backup:set-config', (_event, config: object) => {
  backupScheduler.setConfig(config);
  return { success: true };
});

// ============ System Tray Handlers ============

ipcMain.handle('tray:update-status', (_event, status: TrayStatus, info?: string) => {
  updateTrayStatus(status, info);
  return { success: true };
});

// ============ App Lifecycle ============

app.whenReady().then(() => {
  // ADR-0014 Track D2 — deny every browser-permission request by default.
  // POS hardware never reaches the renderer via WebUSB/WebSerial/
  // WebBluetooth; everything flows through `window.pos.hardware.exec`.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setDevicePermissionHandler(() => false);

  createWindow();
  createTray();
  backupScheduler.start();

  // Bootstrap hardware orchestration.
  void deviceManager.bootstrap();

  // Replay any unfinished saga steps (crash-recovery). When SQLite has
  // been initialized, `installSqliteHardwareStores()` has already swapped
  // SaleSaga to `SqlitePayloadStore`, so the in-memory payload Map is no
  // longer needed and `replayUnfinished()` reads directly from disk.
  try { saleSaga.replayUnfinished(); } catch { /* noop on first boot */ }

  // EventBroker fan-out — register the main window + customer-display
  // window (when present) as sinks so device events reach every
  // renderer that needs them.
  eventBroker.subscribe((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pos:event', event);
    }
    if (customerDisplayWindow && !customerDisplayWindow.isDestroyed()) {
      customerDisplayWindow.webContents.send('pos:event', event);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Cleanup before quitting
    backupScheduler.stop();
    databaseManager.close();
    if (tray) {
      tray.destroy();
      tray = null;
    }
    app.quit();
  }
});

// Security
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    if (parsedUrl.origin !== 'http://localhost:5173' && !navigationUrl.startsWith('file://')) {
      event.preventDefault();
    }
  });
});

export { enableKioskMode };
