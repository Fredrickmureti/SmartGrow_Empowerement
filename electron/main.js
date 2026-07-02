"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.enableKioskMode = enableKioskMode;
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const nodenet = __importStar(require("net"));
const serialport_1 = require("serialport");
const usb = __importStar(require("usb"));
// Native modules are wrapped so a missing or mis-built binary degrades the
// app to "hardware disabled" instead of crashing the main process before
// the window is even created (which manifests as a blank-white-screen
// from the user's perspective).
const nativeModuleErrors = {};
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('serialport');
}
catch (err) {
    nativeModuleErrors.serialport = err.message;
    console.warn('[native] serialport unavailable:', nativeModuleErrors.serialport);
}
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('usb');
}
catch (err) {
    nativeModuleErrors.usb = err.message;
    console.warn('[native] usb unavailable:', nativeModuleErrors.usb);
}
const DatabaseManager_1 = require("./database/DatabaseManager");
const KeyManager_1 = require("./security/KeyManager");
const AuditLogger_1 = require("./database/AuditLogger");
const BackupScheduler_1 = require("./database/BackupScheduler");
const CommandRouter_1 = require("./hardware/CommandRouter");
const EventBroker_1 = require("./hardware/EventBroker");
const CommandQueue_1 = require("./hardware/CommandQueue");
const SaleSaga_1 = require("./hardware/SaleSaga");
const DeviceManager_1 = require("./hardware/DeviceManager");
const SqliteStores_1 = require("./hardware/SqliteStores");
const SessionEnvelope_1 = require("./hardware/SessionEnvelope");
const store_1 = require("./hardware/assignments/store");
const handlers_1 = require("./hardware/handlers");
const SqliteStores_2 = require("./hardware/SqliteStores");
const PaymentService_1 = require("./hardware/payment/PaymentService");
const MockTerminalDriver_1 = require("./hardware/payment/MockTerminalDriver");
const SettlementReconciler_1 = require("./hardware/payment/SettlementReconciler");
const bluetooth_1 = require("./hardware/bluetooth");
// ============ Hardware orchestration singletons (ADR-0014) ============
//
// Stores start in-memory so the IPC seam works pre-login (when the
// encrypted SQLite is sealed). Immediately after `db:initialize`
// succeeds we swap to the SQLite-backed adapters, drain any in-memory
// rows into them, and run `SaleSaga.replayUnfinished` so a mid-sale
// crash from the previous session resumes its print/drawer/display chain.
let _outboxImpl = new SaleSaga_1.InMemoryOutboxStore();
let _queueImpl = new CommandQueue_1.InMemoryQueueStore();
let _paymentLogImpl = new PaymentService_1.InMemoryPaymentLogStore();
const _paymentDriver = new MockTerminalDriver_1.MockTerminalDriver();
const paymentService = new PaymentService_1.PaymentService({
    driver: _paymentDriver,
    store: {
        findByIdempotency: (k) => _paymentLogImpl.findByIdempotency(k),
        insert: (r) => _paymentLogImpl.insert(r),
        update: (id, p) => _paymentLogImpl.update(id, p),
        listApprovedOlderThan: (c) => _paymentLogImpl.listApprovedOlderThan(c),
        findByAuthId: (id) => _paymentLogImpl.findByAuthId(id),
    },
    broker: EventBroker_1.eventBroker,
});
(0, handlers_1.setPaymentService)(paymentService);
/** No-radio fallback so the manager can be constructed before any noble probe. */
const inertRadio = {
    async available() { return false; },
    async pair() { return { ok: false, error: 'bluetooth radio unavailable' }; },
    async unpair() { },
    async connect() { return { ok: false, error: 'bluetooth radio unavailable' }; },
    async disconnect() { },
    async ping() { return { ok: false, latencyMs: 0, error: 'bluetooth radio unavailable' }; },
};
// Proxy stores keep CommandQueue + SaleSaga pinned to a stable reference
// while letting the underlying implementation be swapped post-`db:initialize`.
const outboxStore = {
    upsert: (r) => _outboxImpl.upsert(r),
    update: (s, st, p) => _outboxImpl.update(s, st, p),
    listUnfinished: () => _outboxImpl.listUnfinished(),
    findOne: (s, st) => _outboxImpl.findOne(s, st),
};
const queueStore = {
    findByKey: (k) => _queueImpl.findByKey(k),
    insert: (r) => _queueImpl.insert(r),
    update: (id, p) => _queueImpl.update(id, p),
    nextPending: (role) => _queueImpl.nextPending(role),
    listByStatus: (s, l) => _queueImpl.listByStatus(s, l),
};
const commandQueue = new CommandQueue_1.CommandQueue(queueStore, (cmd) => CommandRouter_1.commandRouter.exec(cmd));
const saleSaga = new SaleSaga_1.SaleSaga(outboxStore, commandQueue);
/**
 * Promote orchestration stores to SQLite-backed implementations and
 * replay any unfinished saga rows from the previous session. Safe to call
 * multiple times — second call is a no-op once the SQLite stores are in place.
 */
function installSqliteHardwareStores() {
    if (_outboxImpl instanceof SqliteStores_1.SqliteOutboxStore && _queueImpl instanceof SqliteStores_1.SqliteQueueStore)
        return;
    const getDb = () => DatabaseManager_1.databaseManager.getDatabase();
    const nextOutbox = new SqliteStores_1.SqliteOutboxStore(getDb);
    const nextQueue = new SqliteStores_1.SqliteQueueStore(getDb);
    // Drain any in-memory rows captured before login into the durable store.
    for (const row of _outboxImpl.listUnfinished()) {
        try {
            nextOutbox.upsert(row);
        }
        catch { /* ignore duplicate */ }
    }
    _outboxImpl = nextOutbox;
    _queueImpl = nextQueue;
    // Track H3b — durable payload store. SaleSaga.setPayloadStore drains
    // any in-memory payloads collected pre-login into the new SQLite store
    // so a crash before logout still has the commit payload on disk.
    try {
        saleSaga.setPayloadStore(new SqliteStores_1.SqlitePayloadStore(getDb));
    }
    catch (err) {
        console.warn('[saga] payload store install failed:', err.message);
    }
    try {
        const replayed = saleSaga.replayUnfinished();
        if (replayed > 0)
            console.log(`[saga] replayed ${replayed} unfinished step(s) from outbox`);
    }
    catch (err) {
        console.warn('[saga] replay failed:', err.message);
    }
    // Track P — swap to SQLite-backed payment log and run settlement reconciler.
    try {
        _paymentLogImpl = new SqliteStores_2.SqlitePaymentLogStore(getDb);
        void new SettlementReconciler_1.SettlementReconciler({
            service: paymentService, store: _paymentLogImpl,
            logger: { info: (m) => console.log(m), error: (m) => console.warn(m) },
        }).runOnce().catch((err) => console.warn('[settlement] runOnce failed:', err));
    }
    catch (err) {
        console.warn('[payment] SQLite log install failed:', err.message);
    }
    // Track B — SQLite-backed pairing store + bootstrap reconnect loop.
    try {
        const btStore = new bluetooth_1.SqliteBtPairingsStore(getDb, KeyManager_1.keyManager);
        const mgr = new bluetooth_1.BluetoothPairingManager({ radio: inertRadio, store: btStore, broker: EventBroker_1.eventBroker });
        (0, bluetooth_1.setBluetoothPairingManager)(mgr);
        void mgr.bootstrap().catch((err) => console.warn('[bluetooth] bootstrap failed:', err));
    }
    catch (err) {
        console.warn('[bluetooth] manager install failed:', err.message);
    }
}
// DeviceManager bootstraps op-handlers per assignment from the
// `pos_device_assignments` SQLite table. Pre-`db:initialize` we have no
// DB, so `loadAssignments` returns an empty list and the manager
// registers nothing — `pos:exec` returns a clean "unknown op" rather
// than crashing. After db init we call `reloadDeviceAssignments()` to
// re-bootstrap with the live store.
let _assignmentStore = null;
const getAssignmentStore = () => {
    if (!_assignmentStore)
        _assignmentStore = new store_1.AssignmentStore(() => DatabaseManager_1.databaseManager.getDatabase());
    return _assignmentStore;
};
const deviceManager = new DeviceManager_1.DeviceManager({
    router: CommandRouter_1.commandRouter,
    broker: EventBroker_1.eventBroker,
    loadAssignments: () => {
        try {
            const rows = getAssignmentStore().loadActive(currentTerminalId);
            return rows.map((r) => ({
                role: r.role,
                transport: r.transport,
                driver: r.driver,
                config: safeJson(r.config_json),
                enabled: r.enabled === 1,
            }));
        }
        catch {
            return [];
        }
    },
    handlers: handlers_1.HARDWARE_HANDLERS,
});
let currentTerminalId = null;
function safeJson(s) {
    if (!s)
        return {};
    try {
        return JSON.parse(s);
    }
    catch {
        return {};
    }
}
/**
 * Re-bootstrap DeviceManager after assignments change or db (re)opens.
 * Idempotent — clears existing router registrations then re-registers.
 */
function reloadDeviceAssignments() {
    try {
        CommandRouter_1.commandRouter._reset();
        deviceManager.stop();
        void deviceManager.bootstrap();
    }
    catch (err) {
        console.warn('[devices] reload failed:', err.message);
    }
}
// Drive the queue on a 200ms tick per role. Tight enough for receipt
// printing to feel instant, loose enough to avoid pegging the CPU.
const POS_ROLES = ['receipt_printer', 'kitchen_printer', 'cash_drawer', 'customer_display', 'payment_terminal'];
setInterval(() => {
    for (const role of POS_ROLES) {
        void commandQueue.tick(role).then((row) => {
            if (!row)
                return;
            // Bridge terminal queue states back into the saga so the outbox
            // mirrors reality.
            if (row.status === 'done' || row.status === 'dead' || row.status === 'failed') {
                const [saleId, step] = row.idempotency_key.split(':');
                if (saleId && step) {
                    try {
                        saleSaga.advance(saleId, step, row.status, row.last_error ?? undefined);
                    }
                    catch { /* row was not saga-owned */ }
                }
            }
        });
    }
}, 200);
let mainWindow = null;
let customerDisplayWindow = null;
let tray = null;
const isDev = process.env.NODE_ENV === 'development';
let currentTrayStatus = 'online';
let trayTooltipInfo = '';
// Secure storage paths
const userDataPath = electron_1.app.getPath('userData');
const secureStoragePath = path.join(userDataPath, 'secure');
// Ensure secure storage directory exists
if (!fs.existsSync(secureStoragePath)) {
    fs.mkdirSync(secureStoragePath, { recursive: true });
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 320,
        minHeight: 480,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
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
                        ? "default-src 'self' http://localhost:5173 ws://localhost:5173 https://*.supabase.co https://jkszmrroyjfdwokbkzis.supabase.co; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; script-src 'self' 'unsafe-eval' http://localhost:5173; connect-src 'self' http://localhost:5173 ws://localhost:5173 https://*.supabase.co wss://*.supabase.co https://*.lovable.app https://*.lovable.dev"
                        : "default-src 'self' file: blob: data:; script-src 'self' file: blob: 'wasm-unsafe-eval'; script-src-elem 'self' file: blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: file: https://fonts.gstatic.com; img-src 'self' data: blob: file: https:; connect-src 'self' file: https://*.supabase.co wss://*.supabase.co https://*.lovable.app https://*.lovable.dev https://ai.gateway.lovable.dev; frame-src 'self' file: data:",
                ],
            },
        });
    });
    // ── Renderer diagnostics (production white-screen forensics) ──
    // Without these, every packaged-build failure looks identical: blank
    // white window. Mirror everything into userData/logs/main.log.
    const logPath = path.join(electron_1.app.getPath('userData'), 'logs', 'main.log');
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
    }
    catch { /* noop */ }
    const logLine = (line) => {
        const stamped = `[${new Date().toISOString()}] ${line}\n`;
        try {
            fs.appendFileSync(logPath, stamped);
        }
        catch { /* noop */ }
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
    mainWindow.webContents.on('did-finish-load', () => logLine('[renderer] did-finish-load'));
    // Pre-flight: assert dist + preload exist before loadFile, otherwise
    // surface a real error dialog instead of a silent blank window.
    const preloadPath = path.join(__dirname, 'preload.js');
    if (!fs.existsSync(preloadPath)) {
        logLine(`[startup] FATAL preload missing at ${preloadPath}`);
        electron_1.dialog.showErrorBox('Startup failure', `Preload script not found:\n${preloadPath}\n\nThe packaged build is incomplete.`);
    }
    // Load the app
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    }
    else {
        // In production, dist is in resources folder (extraResources)
        const distPath = path.join(process.resourcesPath, 'dist', 'index.html');
        if (!fs.existsSync(distPath)) {
            logLine(`[startup] FATAL dist index.html missing at ${distPath}`);
            electron_1.dialog.showErrorBox('Startup failure', `Application bundle missing:\n${distPath}\n\nThe Vite build did not run with ELECTRON_BUILD=1, or extraResources did not copy.`);
        }
        mainWindow.loadFile(distPath).catch((err) => {
            logLine(`[startup] loadFile rejected: ${err.message}`);
        });
        if (process.env.POS_DEBUG === '1') {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
    }
    // Handle external links
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        electron_1.shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.on('closed', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            SessionEnvelope_1.sessionEnvelope.release(mainWindow.webContents.id);
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
    const icon = electron_1.nativeImage.createFromPath(iconPath);
    // Fallback: create a simple colored icon programmatically
    const trayIcon = icon.isEmpty()
        ? createColoredTrayIcon('online')
        : icon.resize({ width: 16, height: 16 });
    tray = new electron_1.Tray(trayIcon);
    tray.setToolTip('Business Suite - Online');
    // Click to show main window
    tray.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
    });
    updateTrayMenu();
}
function createColoredTrayIcon(status) {
    // Create a 16x16 colored circle based on status
    const colors = {
        online: '#22c55e', // Green
        offline: '#ef4444', // Red
        syncing: '#3b82f6', // Blue
        warning: '#f59e0b', // Yellow
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
                canvas[idx] = r; // R
                canvas[idx + 1] = g; // G
                canvas[idx + 2] = b; // B
                canvas[idx + 3] = 255; // A
            }
            else {
                canvas[idx] = 0;
                canvas[idx + 1] = 0;
                canvas[idx + 2] = 0;
                canvas[idx + 3] = 0;
            }
        }
    }
    return electron_1.nativeImage.createFromBuffer(canvas, { width: size, height: size });
}
function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
        ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
        : [0, 128, 0];
}
function updateTrayStatus(status, info) {
    if (!tray)
        return;
    currentTrayStatus = status;
    trayTooltipInfo = info || '';
    const icon = createColoredTrayIcon(status);
    tray.setImage(icon);
    const tooltips = {
        online: 'Business Suite - Online',
        offline: 'Business Suite - Offline (POS Only)',
        syncing: `Business Suite - Syncing${info ? ` (${info})` : ''}`,
        warning: `Business Suite - ${info || 'Warning: Failed transactions'}`,
    };
    tray.setToolTip(tooltips[status]);
    updateTrayMenu();
}
function updateTrayMenu() {
    if (!tray)
        return;
    const statusLabel = currentTrayStatus === 'online' ? '✓ Online'
        : currentTrayStatus === 'offline' ? '✗ Offline'
            : currentTrayStatus === 'syncing' ? '↻ Syncing...'
                : '⚠ Warning';
    const contextMenu = electron_1.Menu.buildFromTemplate([
        { label: 'Open Business Suite', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { type: 'separator' },
        { label: `Status: ${statusLabel}`, enabled: false },
        { label: `Pending: ${syncStatus.pendingCount} transactions`, enabled: false },
        { label: syncStatus.lastSyncAt ? `Last Sync: ${new Date(syncStatus.lastSyncAt).toLocaleTimeString()}` : 'Never synced', enabled: false },
        { type: 'separator' },
        { label: 'Sync Now', click: () => mainWindow?.webContents.send('offline:sync-requested') },
        { label: 'Backup Now', click: async () => {
                const result = await BackupScheduler_1.backupScheduler.runBackup();
                if (result.success) {
                    mainWindow?.webContents.send('backup:completed', result);
                }
            } },
        { type: 'separator' },
        { label: 'Quit', click: () => electron_1.app.quit() },
    ]);
    tray.setContextMenu(contextMenu);
}
let lastOnlineState = true;
function startNetworkMonitoring() {
    // Check network status every 3 seconds
    setInterval(() => {
        const currentOnline = electron_1.net.isOnline();
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
electron_1.ipcMain.handle('network:check-online', async () => {
    // Do a real connectivity check by trying to reach the Supabase endpoint
    return electron_1.net.isOnline();
});
electron_1.ipcMain.handle('network:get-status', () => {
    return electron_1.net.isOnline();
});
// ============ Secure Storage ============
function getSecureFilePath(key) {
    return path.join(secureStoragePath, `${key}.enc`);
}
electron_1.ipcMain.handle('secure-storage:save', async (_event, key, data) => {
    try {
        if (!electron_1.safeStorage.isEncryptionAvailable()) {
            // Fallback: store without encryption (not recommended for production)
            fs.writeFileSync(getSecureFilePath(key), data);
            return { success: true, encrypted: false };
        }
        const encrypted = electron_1.safeStorage.encryptString(data);
        fs.writeFileSync(getSecureFilePath(key), encrypted);
        return { success: true, encrypted: true };
    }
    catch (error) {
        console.error('Failed to save secure data:', error);
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('secure-storage:load', async (_event, key) => {
    try {
        const filePath = getSecureFilePath(key);
        if (!fs.existsSync(filePath)) {
            return { success: true, data: null };
        }
        const fileContent = fs.readFileSync(filePath);
        if (!electron_1.safeStorage.isEncryptionAvailable()) {
            return { success: true, data: fileContent.toString() };
        }
        const decrypted = electron_1.safeStorage.decryptString(fileContent);
        return { success: true, data: decrypted };
    }
    catch (error) {
        console.error('Failed to load secure data:', error);
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('secure-storage:delete', async (_event, key) => {
    try {
        const filePath = getSecureFilePath(key);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return { success: true };
    }
    catch (error) {
        console.error('Failed to delete secure data:', error);
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('secure-storage:clear-all', async () => {
    try {
        const files = fs.readdirSync(secureStoragePath);
        for (const file of files) {
            fs.unlinkSync(path.join(secureStoragePath, file));
        }
        return { success: true };
    }
    catch (error) {
        console.error('Failed to clear secure storage:', error);
        return { success: false, error: error.message };
    }
});
let syncStatus = {
    lastSyncAt: null,
    pendingCount: 0,
    failedCount: 0,
};
electron_1.ipcMain.handle('offline:get-sync-status', () => {
    return syncStatus;
});
electron_1.ipcMain.handle('offline:update-sync-status', (_event, status) => {
    syncStatus = { ...syncStatus, ...status };
    return syncStatus;
});
electron_1.ipcMain.handle('offline:trigger-sync', () => {
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
electron_1.ipcMain.handle('serial:list-ports', async () => {
    try {
        const ports = await serialport_1.SerialPort.list();
        return ports.map(port => ({
            path: port.path,
            manufacturer: port.manufacturer,
            serialNumber: port.serialNumber,
            vendorId: port.vendorId,
            productId: port.productId,
        }));
    }
    catch (error) {
        console.error('Failed to list serial ports:', error);
        return [];
    }
});
let activeSerialPort = null;
electron_1.ipcMain.handle('serial:connect', async (_event, portPath, baudRate) => {
    try {
        if (activeSerialPort?.isOpen) {
            activeSerialPort.close();
        }
        activeSerialPort = new serialport_1.SerialPort({
            path: portPath,
            baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
        });
        activeSerialPort.on('data', (data) => {
            mainWindow?.webContents.send('serial:data', data.toString());
        });
        activeSerialPort.on('error', (err) => {
            mainWindow?.webContents.send('serial:error', err.message);
        });
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('serial:disconnect', async () => {
    try {
        if (activeSerialPort?.isOpen) {
            activeSerialPort.close();
            activeSerialPort = null;
        }
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('serial:write', async (_event, data) => {
    try {
        if (activeSerialPort?.isOpen) {
            activeSerialPort.write(data);
            return { success: true };
        }
        return { success: false, error: 'Port not open' };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
// ============ USB Handlers ============
electron_1.ipcMain.handle('usb:list-devices', async () => {
    try {
        const devices = usb.getDeviceList();
        return devices.map(device => ({
            vendorId: device.deviceDescriptor.idVendor,
            productId: device.deviceDescriptor.idProduct,
            manufacturer: device.deviceDescriptor.iManufacturer,
        }));
    }
    catch (error) {
        console.error('Failed to list USB devices:', error);
        return [];
    }
});
electron_1.ipcMain.handle('usb:print', async (_event, vendorId, productId, data) => {
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
            outEndpoint.transfer(Buffer.from(data), (err) => {
                iface.release(() => device.close());
                if (err) {
                    resolve({ success: false, error: err.message });
                }
                else {
                    resolve({ success: true });
                }
            });
        });
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('usb:open-drawer', async (_event, vendorId, productId) => {
    // ADR-0014: legacy channel preserved for the migration window but it
    // now routes through the same USB transport as `usb:print` instead of
    // the pre-fix `ipcMain.emit(...)` no-op that silently swallowed every
    // drawer kick. New callers should use `window.pos.hardware.exec` with
    // `{ role: 'cash_drawer', op: 'open' }` — see CommandRouter.
    const openDrawerCommand = [0x1B, 0x70, 0x00, 0x19, 0xFA];
    try {
        const device = usb.findByIds(vendorId, productId);
        if (!device)
            return { success: false, error: 'Device not found' };
        device.open();
        const iface = device.interfaces?.[0];
        if (!iface) {
            device.close();
            return { success: false, error: 'No interface found' };
        }
        if (iface.isKernelDriverActive())
            iface.detachKernelDriver();
        iface.claim();
        const outEndpoint = iface.endpoints.find(ep => ep.direction === 'out');
        if (!outEndpoint) {
            iface.release(() => device.close());
            return { success: false, error: 'No output endpoint found' };
        }
        return await new Promise((resolve) => {
            outEndpoint.transfer(Buffer.from(openDrawerCommand), (err) => {
                iface.release(() => device.close());
                resolve(err ? { success: false, error: err.message } : { success: true });
            });
        });
    }
    catch (error) {
        return { success: false, error: error.message };
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
electron_1.ipcMain.handle('pos:session:get-secret', (event) => {
    return SessionEnvelope_1.sessionEnvelope.getOrCreateSecret(event.sender.id);
});
electron_1.ipcMain.handle('pos:exec', async (event, raw) => {
    const verified = SessionEnvelope_1.sessionEnvelope.verify(event.sender.id, raw);
    if (!verified.ok)
        return { ok: false, error: `envelope rejected: ${verified.reason}` };
    return CommandRouter_1.commandRouter.exec(verified.payload);
});
electron_1.ipcMain.handle('pos:sale-committed', async (event, raw) => {
    // ADR-0014 Track C2 + H3 — renderer fires this after the local DB
    // commit. Envelope-verified, then handed to the saga which writes the
    // 4 outbox rows + enqueues the matching ops on the CommandQueue.
    // Idempotent on `payload.saleId`.
    const verified = SessionEnvelope_1.sessionEnvelope.verify(event.sender.id, raw);
    if (!verified.ok)
        return { ok: false, error: `envelope rejected: ${verified.reason}` };
    const payload = verified.payload;
    if (!payload || typeof payload !== 'object' || typeof payload.saleId !== 'string') {
        return { ok: false, error: 'invalid sale payload' };
    }
    try {
        // Payload persistence is owned by SaleSaga's PayloadStore (SQLite
        // after login, in-memory pre-login). No more shadow Map here.
        saleSaga.commit(payload);
        return { ok: true, queued: true };
    }
    catch (err) {
        return { ok: false, error: err.message };
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
electron_1.ipcMain.handle('pos:devices:list', async () => {
    try {
        return { ok: true, rows: getAssignmentStore().list() };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
});
electron_1.ipcMain.handle('pos:devices:upsert', async (_event, input) => {
    try {
        if (!input || typeof input !== 'object')
            return { ok: false, error: 'invalid input' };
        if (typeof input.role !== 'string' || typeof input.transport !== 'string' || typeof input.driver !== 'string') {
            return { ok: false, error: 'role/transport/driver required' };
        }
        const row = getAssignmentStore().upsert(input);
        reloadDeviceAssignments();
        return { ok: true, row };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
});
electron_1.ipcMain.handle('pos:devices:remove', async (_event, id) => {
    try {
        const removed = getAssignmentStore().remove(Number(id));
        if (removed)
            reloadDeviceAssignments();
        return { ok: true, removed };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
});
electron_1.ipcMain.handle('pos:devices:set-terminal', async (_event, terminalId) => {
    currentTerminalId = (terminalId && typeof terminalId === 'string') ? terminalId : null;
    reloadDeviceAssignments();
    return { ok: true, terminalId: currentTerminalId };
});
// ============ Device lifecycle (Track H1) =================================
//
// Renderer-side `HardwareClient.{isRoleAvailable, reconnectRole, getStatuses}`
// now route through here when running inside Electron, instead of falling back
// to the browser DriverRegistry path. DeviceManager owns lifecycle; the
// renderer never instantiates a driver in Electron mode.
electron_1.ipcMain.handle('pos:devices:status', async () => {
    try {
        // Track H7b — honest liveness from DeviceManager.getStatuses(), not
        // "is a handler registered". A handler stays registered after the USB
        // cable is pulled; the ping loop is the only authority on whether the
        // device is actually reachable.
        const active = deviceManager.getActive();
        const live = deviceManager.getStatuses();
        const statuses = [];
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
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
});
electron_1.ipcMain.handle('pos:devices:reconnect', async (_event, role) => {
    try {
        // Track H7c — per-role refresh. The previous rebootstrap-everything
        // approach tore down sibling handlers (clicking Reconnect on the scale
        // would briefly drop the receipt printer). DeviceManager.refresh()
        // forces an immediate probe of just the named role without touching
        // the others.
        if (typeof role !== 'string' || role.length === 0) {
            return { ok: false, error: 'role required' };
        }
        const status = await deviceManager.refresh(role);
        if (status === null) {
            return { ok: false, error: `no active assignment for role '${role}'` };
        }
        return { ok: true, status };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
});
// ============= Bluetooth pairings (Track B-UI) =============
// Thin wrappers; all logic + sanitisation lives in
// `electron/hardware/bluetooth/ipc.ts` (unit-tested module).
electron_1.ipcMain.handle('pos:bluetooth:radio-available', async () => {
    const mgr = (0, bluetooth_1.getBluetoothPairingManager)();
    return { ok: Boolean(mgr) };
});
electron_1.ipcMain.handle('pos:bluetooth:list', async () => (0, bluetooth_1.ipcList)(bluetooth_1.getBluetoothPairingManager));
electron_1.ipcMain.handle('pos:bluetooth:pair', async (_e, input) => (0, bluetooth_1.ipcPair)(bluetooth_1.getBluetoothPairingManager, input));
electron_1.ipcMain.handle('pos:bluetooth:unpair', async (_e, deviceId) => (0, bluetooth_1.ipcUnpair)(bluetooth_1.getBluetoothPairingManager, String(deviceId ?? '')));
electron_1.ipcMain.handle('pos:bluetooth:connect', async (_e, deviceId) => (0, bluetooth_1.ipcConnect)(bluetooth_1.getBluetoothPairingManager, String(deviceId ?? '')));
electron_1.ipcMain.handle('pos:bluetooth:disconnect', async (_e, deviceId) => (0, bluetooth_1.ipcDisconnect)(bluetooth_1.getBluetoothPairingManager, String(deviceId ?? '')));
electron_1.ipcMain.handle('pos:bluetooth:health', async (_e, deviceId) => (0, bluetooth_1.ipcHealth)(bluetooth_1.getBluetoothPairingManager, String(deviceId ?? '')));
electron_1.ipcMain.handle('window:get-size', () => {
    if (mainWindow) {
        const [width, height] = mainWindow.getSize();
        return { width, height };
    }
    return { width: 1400, height: 900 };
});
// ============ App Control Handlers ============
electron_1.ipcMain.handle('app:quit', () => {
    electron_1.app.quit();
});
electron_1.ipcMain.handle('app:minimize', () => {
    mainWindow?.minimize();
});
electron_1.ipcMain.handle('app:maximize', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    }
    else {
        mainWindow?.maximize();
    }
});
electron_1.ipcMain.handle('app:enable-kiosk', () => {
    enableKioskMode();
});
electron_1.ipcMain.handle('app:disable-kiosk', () => {
    if (mainWindow) {
        mainWindow.setKiosk(false);
        mainWindow.setAlwaysOnTop(false);
    }
});
electron_1.ipcMain.handle('app:get-version', () => {
    return electron_1.app.getVersion();
});
electron_1.ipcMain.handle('app:get-path', (_event, name) => {
    return electron_1.app.getPath(name);
});
// ============ Customer Display Handlers ============
electron_1.ipcMain.handle('customer-display:get-displays', () => {
    const displays = electron_1.screen.getAllDisplays();
    return displays.map((display, index) => ({
        id: index,
        label: display.label || `Display ${index + 1}`,
        primary: display.id === electron_1.screen.getPrimaryDisplay().id,
        bounds: display.bounds,
    }));
});
electron_1.ipcMain.handle('customer-display:open', async (_event, displayIndex, fullscreen) => {
    try {
        const displays = electron_1.screen.getAllDisplays();
        const targetDisplay = displays[displayIndex] || displays[displays.length - 1];
        if (!targetDisplay) {
            return { success: false, error: 'No display available' };
        }
        if (customerDisplayWindow && !customerDisplayWindow.isDestroyed()) {
            customerDisplayWindow.close();
        }
        customerDisplayWindow = new electron_1.BrowserWindow({
            x: targetDisplay.bounds.x,
            y: targetDisplay.bounds.y,
            width: targetDisplay.bounds.width,
            height: targetDisplay.bounds.height,
            fullscreen: fullscreen,
            frame: false,
            alwaysOnTop: true,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
            title: 'Customer Display',
        });
        if (isDev) {
            customerDisplayWindow.loadURL('http://localhost:5173/#/pos/customer-display');
        }
        else {
            // Use hash routing for file:// protocol
            const distPath = path.join(process.resourcesPath, 'dist', 'index.html');
            customerDisplayWindow.loadFile(distPath, { hash: '/pos/customer-display' });
        }
        customerDisplayWindow.on('closed', () => {
            if (customerDisplayWindow)
                SessionEnvelope_1.sessionEnvelope.release(customerDisplayWindow.webContents.id);
            customerDisplayWindow = null;
        });
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('customer-display:close', () => {
    try {
        if (customerDisplayWindow && !customerDisplayWindow.isDestroyed()) {
            customerDisplayWindow.close();
            customerDisplayWindow = null;
        }
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('customer-display:update', (_event, data) => {
    try {
        // Track H1 — broadcast through the EventBroker so the customer-display
        // window can consume via `window.pos.hardware.subscribe` instead of the
        // legacy `electronAPI.customerDisplay.onUpdate` channel. The direct
        // webContents.send below stays for the migration window; the broker
        // path is the chokepoint going forward.
        EventBroker_1.eventBroker.publish({
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
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('customer-display:is-open', () => {
    return customerDisplayWindow !== null && !customerDisplayWindow.isDestroyed();
});
// ============ SQLite Database Handlers ============
electron_1.ipcMain.handle('db:initialize', async (_event, password, userId) => {
    try {
        const encryptionKey = await KeyManager_1.keyManager.deriveKey(password, userId);
        const result = await DatabaseManager_1.databaseManager.initialize(encryptionKey);
        if (result && result.success !== false) {
            try {
                installSqliteHardwareStores();
            }
            catch (err) {
                console.warn('[hw] SQLite store install failed:', err.message);
            }
            // Re-bootstrap DeviceManager now that the assignments table is reachable.
            reloadDeviceAssignments();
        }
        return result;
    }
    catch (error) {
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('db:query', async (_event, sql, params) => {
    return DatabaseManager_1.databaseManager.execute(sql, params);
});
electron_1.ipcMain.handle('db:transaction', async (_event, queries) => {
    return DatabaseManager_1.databaseManager.executeTransaction(queries);
});
electron_1.ipcMain.handle('db:backup', async (_event, backupPath) => {
    return await DatabaseManager_1.databaseManager.backup(backupPath);
});
electron_1.ipcMain.handle('db:vacuum', async () => {
    return DatabaseManager_1.databaseManager.vacuum();
});
electron_1.ipcMain.handle('db:get-stats', async () => {
    return DatabaseManager_1.databaseManager.getStats();
});
electron_1.ipcMain.handle('db:get-path', () => {
    return DatabaseManager_1.databaseManager.getPath();
});
electron_1.ipcMain.handle('db:is-ready', () => {
    return DatabaseManager_1.databaseManager.isReady();
});
electron_1.ipcMain.handle('db:close', () => {
    DatabaseManager_1.databaseManager.close();
    KeyManager_1.keyManager.clearKey();
    return { success: true };
});
// ============ Key Manager Handlers ============
electron_1.ipcMain.handle('key:hash-password', (_event, password) => {
    return KeyManager_1.keyManager.hashPassword(password);
});
electron_1.ipcMain.handle('key:verify-password', (_event, password, hash) => {
    return KeyManager_1.keyManager.verifyPassword(password, hash);
});
electron_1.ipcMain.handle('key:hash-pin', (_event, pin) => {
    return KeyManager_1.keyManager.hashPin(pin);
});
electron_1.ipcMain.handle('key:verify-pin', (_event, pin, hash) => {
    return KeyManager_1.keyManager.verifyPin(pin, hash);
});
// ============ Audit Logger Handlers ============
electron_1.ipcMain.handle('audit:set-context', (_event, orgId, userId, email) => {
    AuditLogger_1.auditLogger.setContext(orgId, userId, email);
    return { success: true };
});
electron_1.ipcMain.handle('audit:log', async (_event, action, table, recordId, oldData, newData) => {
    await AuditLogger_1.auditLogger.log(action, table, recordId, oldData, newData);
    return { success: true };
});
electron_1.ipcMain.handle('audit:get-unsynced', (_event, limit) => {
    return AuditLogger_1.auditLogger.getUnsyncedLogs(limit);
});
electron_1.ipcMain.handle('audit:mark-synced', (_event, ids) => {
    AuditLogger_1.auditLogger.markAsSynced(ids);
    return { success: true };
});
// ============ Print Handlers ============
electron_1.ipcMain.handle('print:html', async (_event, html, options) => {
    try {
        // Create a hidden window to render the HTML
        const printWindow = new electron_1.BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        // Load the HTML content using data URL
        await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        // Wait for content to render
        await new Promise(resolve => setTimeout(resolve, 500));
        // Print with native dialog
        const result = await new Promise((resolve) => {
            printWindow.webContents.print({
                silent: false,
                printBackground: true,
                ...options,
            }, (success) => {
                printWindow.close();
                resolve(success);
            });
        });
        return { success: result };
    }
    catch (error) {
        console.error('Print failed:', error);
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('print:silent', async (_event, html, printerName) => {
    try {
        const printWindow = new electron_1.BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        await new Promise(resolve => setTimeout(resolve, 300));
        await new Promise((resolve, reject) => {
            printWindow.webContents.print({
                silent: true,
                printBackground: true,
                deviceName: printerName || '',
            }, (success) => {
                printWindow.close();
                success ? resolve() : reject(new Error('Print failed'));
            });
        });
        return { success: true };
    }
    catch (error) {
        console.error('Silent print failed:', error);
        return { success: false, error: error.message };
    }
});
electron_1.ipcMain.handle('print:get-printers', async () => {
    if (!mainWindow)
        return [];
    try {
        const printers = await mainWindow.webContents.getPrintersAsync();
        return printers.map(printer => ({
            name: printer.name,
            displayName: printer.displayName,
            description: printer.description,
            status: printer.status,
            isDefault: printer.isDefault,
        }));
    }
    catch (error) {
        console.error('Failed to get printers:', error);
        return [];
    }
});
electron_1.ipcMain.handle('print:to-pdf', async (_event, html, savePath) => {
    try {
        const printWindow = new electron_1.BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        await new Promise(resolve => setTimeout(resolve, 300));
        const pdfData = await printWindow.webContents.printToPDF({
            printBackground: true,
            pageSize: 'A4',
        });
        fs.writeFileSync(savePath, pdfData);
        printWindow.close();
        return { success: true, path: savePath };
    }
    catch (error) {
        console.error('PDF generation failed:', error);
        return { success: false, error: error.message };
    }
});
// ============ Network Printer TCP Handlers ============
let networkPrinterSocket = null;
electron_1.ipcMain.handle('network-printer:connect', async (_event, ipAddress, port, timeout = 5000) => {
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
electron_1.ipcMain.handle('network-printer:disconnect', async () => {
    console.log(`[NetworkPrinter] Disconnecting`);
    if (networkPrinterSocket) {
        networkPrinterSocket.destroy();
        networkPrinterSocket = null;
    }
    return { success: true };
});
electron_1.ipcMain.handle('network-printer:print', async (_event, data) => {
    console.log(`[NetworkPrinter] Printing ${data.length} bytes`);
    if (!networkPrinterSocket || networkPrinterSocket.destroyed) {
        return { success: false, error: 'Printer not connected' };
    }
    return new Promise((resolve) => {
        const buffer = Buffer.from(data);
        networkPrinterSocket.write(buffer, (err) => {
            if (err) {
                console.error(`[NetworkPrinter] Print error:`, err.message);
                resolve({ success: false, error: err.message });
            }
            else {
                console.log(`[NetworkPrinter] Print successful`);
                resolve({ success: true });
            }
        });
    });
});
electron_1.ipcMain.handle('network-printer:test', async (_event, ipAddress, port, timeout = 5000) => {
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
electron_1.ipcMain.handle('network-printer:is-connected', () => {
    const connected = networkPrinterSocket !== null && !networkPrinterSocket.destroyed;
    console.log(`[NetworkPrinter] Connection check: ${connected}`);
    return { connected };
});
// ============ Backup Scheduler Handlers ============
electron_1.ipcMain.handle('backup:run-now', async () => {
    return await BackupScheduler_1.backupScheduler.runBackup();
});
electron_1.ipcMain.handle('backup:list', async () => {
    const backups = await BackupScheduler_1.backupScheduler.listBackups();
    return backups.map(b => ({
        path: b.path,
        filename: b.filename,
        date: b.date.toISOString(),
        size: b.size,
    }));
});
electron_1.ipcMain.handle('backup:restore', async (_event, backupPath) => {
    return await BackupScheduler_1.backupScheduler.restoreFromBackup(backupPath);
});
electron_1.ipcMain.handle('backup:get-config', () => {
    return BackupScheduler_1.backupScheduler.getConfig();
});
electron_1.ipcMain.handle('backup:set-config', (_event, config) => {
    BackupScheduler_1.backupScheduler.setConfig(config);
    return { success: true };
});
// ============ System Tray Handlers ============
electron_1.ipcMain.handle('tray:update-status', (_event, status, info) => {
    updateTrayStatus(status, info);
    return { success: true };
});
// ============ App Lifecycle ============
electron_1.app.whenReady().then(() => {
    // ADR-0014 Track D2 — deny every browser-permission request by default.
    // POS hardware never reaches the renderer via WebUSB/WebSerial/
    // WebBluetooth; everything flows through `window.pos.hardware.exec`.
    electron_1.session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    electron_1.session.defaultSession.setDevicePermissionHandler(() => false);
    createWindow();
    createTray();
    BackupScheduler_1.backupScheduler.start();
    // Bootstrap hardware orchestration.
    void deviceManager.bootstrap();
    // Replay any unfinished saga steps (crash-recovery). When SQLite has
    // been initialized, `installSqliteHardwareStores()` has already swapped
    // SaleSaga to `SqlitePayloadStore`, so the in-memory payload Map is no
    // longer needed and `replayUnfinished()` reads directly from disk.
    try {
        saleSaga.replayUnfinished();
    }
    catch { /* noop on first boot */ }
    // EventBroker fan-out — register the main window + customer-display
    // window (when present) as sinks so device events reach every
    // renderer that needs them.
    EventBroker_1.eventBroker.subscribe((event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pos:event', event);
        }
        if (customerDisplayWindow && !customerDisplayWindow.isDestroyed()) {
            customerDisplayWindow.webContents.send('pos:event', event);
        }
    });
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        // Cleanup before quitting
        BackupScheduler_1.backupScheduler.stop();
        DatabaseManager_1.databaseManager.close();
        if (tray) {
            tray.destroy();
            tray = null;
        }
        electron_1.app.quit();
    }
});
// Security
electron_1.app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl);
        if (parsedUrl.origin !== 'http://localhost:5173' && !navigationUrl.startsWith('file://')) {
            event.preventDefault();
        }
    });
});
//# sourceMappingURL=main.js.map