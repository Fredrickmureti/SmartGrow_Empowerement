"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_crypto_1 = require("node:crypto");
/**
 * window.pos — capability-scoped renderer surface (ADR-0014 Tracks H2 + H3).
 *
 * This is the ONLY sanctioned bridge from renderer → main process. The
 * legacy `window.electronAPI` namespace was removed in Track H2; the
 * `local/no-raw-hardware-ipc` ESLint rule blocks any regression.
 *
 * Track H3 hardens the hardware path with an HMAC envelope:
 *   - On first hardware call, preload fetches a per-webContents session
 *     secret via `pos:session:get-secret` (main keys it by sender id).
 *     The secret lives in a preload-scope closure and is NEVER exposed
 *     via `contextBridge` — renderer JS cannot read it.
 *   - Every `pos.hardware.exec` and `pos.sale.committed` call is wrapped
 *     in `{ ts, nonce, sig, payload }` where
 *       sig = HMAC_SHA256(secret, `${ts}.${sha256(JSON(payload)+nonce)}`)
 *   - Main verifies skew (<30s), nonce-replay (LRU 5min), webContents.id
 *     pin, and signature constant-time. `NetworkTransport.sign/verify`
 *     are reused for the helper proofs.
 *
 * Namespace layout:
 *   pos.isElectron / pos.platform     — environment flags
 *   pos.hardware.*                    — device exec + event bus (signed)
 *   pos.devices.*                     — device registry + lifecycle
 *   pos.sale.committed                — saga commit (signed)
 *   pos.app.*                         — quit/minimize/maximize/getPath/etc.
 *   pos.app.customerDisplay.*         — secondary BrowserWindow (window orch)
 *   pos.app.window.*                  — main-window utilities
 *   pos.network.*                     — kiosk online/offline status
 *   pos.storage.secureStorage.*       — encrypted credential KV
 *   pos.storage.keyManager.*          — password/PIN hashing
 *   pos.offline.*                     — sync-status + queue triggers
 *   pos.offline.database.*            — local SQLite handle
 *   pos.offline.audit.*               — local audit log
 *   pos.offline.backup.*              — backup scheduler
 *   pos.print.*                       — document printing (HTML→PDF, silent)
 *   pos.tray.*                        — system-tray status surface
 *   pos.erp                           — online-only-module manifest
 */
// ── HMAC envelope (Track H3) ────────────────────────────────────────────────
let cachedSecret = null;
async function getSecret() {
    if (cachedSecret)
        return cachedSecret;
    const s = await electron_1.ipcRenderer.invoke('pos:session:get-secret');
    if (typeof s !== 'string' || s.length < 32) {
        throw new Error('pos: failed to acquire session secret');
    }
    cachedSecret = s;
    return s;
}
function sign(secret, ts, payloadJson, nonce) {
    // Match NetworkTransport.sign — `${ts}.${sha256(body)}` where body
    // commits to payload + nonce so replay across nonces is impossible.
    const bodyHash = (0, node_crypto_1.createHash)('sha256').update(payloadJson + '|' + nonce).digest('hex');
    return (0, node_crypto_1.createHmac)('sha256', secret).update(`${ts}.${bodyHash}`).digest('hex');
}
async function envelope(payload) {
    const secret = await getSecret();
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = (0, node_crypto_1.randomBytes)(12).toString('hex');
    const payloadJson = JSON.stringify(payload ?? null);
    const sig = sign(secret, ts, payloadJson, nonce);
    return { payload, ts, nonce, sig };
}
electron_1.contextBridge.exposeInMainWorld('pos', {
    isElectron: true,
    platform: process.platform,
    // ===== Hardware (Track H1 + H3 envelope signing) =====
    hardware: {
        exec: async (cmd) => electron_1.ipcRenderer.invoke('pos:exec', await envelope(cmd)),
        subscribe: (callback) => {
            const listener = (_e, event) => callback(event);
            electron_1.ipcRenderer.on('pos:event', listener);
            return () => electron_1.ipcRenderer.removeListener('pos:event', listener);
        },
    },
    sale: {
        committed: async (payload) => electron_1.ipcRenderer.invoke('pos:sale-committed', await envelope(payload)),
    },
    devices: {
        list: () => electron_1.ipcRenderer.invoke('pos:devices:list'),
        upsert: (input) => electron_1.ipcRenderer.invoke('pos:devices:upsert', input),
        remove: (id) => electron_1.ipcRenderer.invoke('pos:devices:remove', id),
        setTerminal: (terminalId) => electron_1.ipcRenderer.invoke('pos:devices:set-terminal', terminalId),
        status: () => electron_1.ipcRenderer.invoke('pos:devices:status'),
        reconnect: (role) => electron_1.ipcRenderer.invoke('pos:devices:reconnect', role),
    },
    // ===== Bluetooth pairings (Track B-UI) =====
    // Manager calls; never returns plaintext link keys.
    bluetooth: {
        radioAvailable: () => electron_1.ipcRenderer.invoke('pos:bluetooth:radio-available'),
        list: () => electron_1.ipcRenderer.invoke('pos:bluetooth:list'),
        pair: (input) => electron_1.ipcRenderer.invoke('pos:bluetooth:pair', input),
        unpair: (deviceId) => electron_1.ipcRenderer.invoke('pos:bluetooth:unpair', deviceId),
        connect: (deviceId) => electron_1.ipcRenderer.invoke('pos:bluetooth:connect', deviceId),
        disconnect: (deviceId) => electron_1.ipcRenderer.invoke('pos:bluetooth:disconnect', deviceId),
        health: (deviceId) => electron_1.ipcRenderer.invoke('pos:bluetooth:health', deviceId),
    },
    // ===== App lifecycle & window orchestration =====
    app: {
        quit: () => electron_1.ipcRenderer.invoke('app:quit'),
        minimize: () => electron_1.ipcRenderer.invoke('app:minimize'),
        maximize: () => electron_1.ipcRenderer.invoke('app:maximize'),
        enableKiosk: () => electron_1.ipcRenderer.invoke('app:enable-kiosk'),
        disableKiosk: () => electron_1.ipcRenderer.invoke('app:disable-kiosk'),
        getVersion: () => electron_1.ipcRenderer.invoke('app:get-version'),
        getPath: (name) => electron_1.ipcRenderer.invoke('app:get-path', name),
        window: {
            getSize: () => electron_1.ipcRenderer.invoke('window:get-size'),
            onResize: (callback) => {
                electron_1.ipcRenderer.on('window:resize', (_event, width, height) => callback(width, height));
            },
            removeResizeListener: () => {
                electron_1.ipcRenderer.removeAllListeners('window:resize');
            },
        },
        // Customer display is secondary-BrowserWindow orchestration, not device IO.
        // Device-IO updates flow through pos.hardware.subscribe('customer_display:update').
        customerDisplay: {
            getDisplays: () => electron_1.ipcRenderer.invoke('customer-display:get-displays'),
            open: (displayIndex, fullscreen) => electron_1.ipcRenderer.invoke('customer-display:open', displayIndex, fullscreen),
            close: () => electron_1.ipcRenderer.invoke('customer-display:close'),
            update: (data) => electron_1.ipcRenderer.invoke('customer-display:update', data),
            isOpen: () => electron_1.ipcRenderer.invoke('customer-display:is-open'),
        },
    },
    // ===== Kiosk network status =====
    network: {
        checkOnline: () => electron_1.ipcRenderer.invoke('network:check-online'),
        getStatus: () => electron_1.ipcRenderer.invoke('network:get-status'),
        onStatusChange: (callback) => {
            electron_1.ipcRenderer.on('network:status-change', (_event, isOnline) => callback(isOnline));
        },
        onRestored: (callback) => {
            electron_1.ipcRenderer.on('network:restored', () => callback());
        },
        removeAllListeners: () => {
            electron_1.ipcRenderer.removeAllListeners('network:status-change');
            electron_1.ipcRenderer.removeAllListeners('network:restored');
        },
    },
    // ===== Encrypted local storage =====
    storage: {
        secureStorage: {
            save: (key, data) => electron_1.ipcRenderer.invoke('secure-storage:save', key, data),
            load: (key) => electron_1.ipcRenderer.invoke('secure-storage:load', key),
            delete: (key) => electron_1.ipcRenderer.invoke('secure-storage:delete', key),
            clearAll: () => electron_1.ipcRenderer.invoke('secure-storage:clear-all'),
        },
        keyManager: {
            hashPassword: (password) => electron_1.ipcRenderer.invoke('key:hash-password', password),
            verifyPassword: (password, hash) => electron_1.ipcRenderer.invoke('key:verify-password', password, hash),
            hashPin: (pin) => electron_1.ipcRenderer.invoke('key:hash-pin', pin),
            verifyPin: (pin, hash) => electron_1.ipcRenderer.invoke('key:verify-pin', pin, hash),
        },
    },
    // ===== Offline / local-DB concerns =====
    offline: {
        getSyncStatus: () => electron_1.ipcRenderer.invoke('offline:get-sync-status'),
        updateSyncStatus: (status) => electron_1.ipcRenderer.invoke('offline:update-sync-status', status),
        triggerSync: () => electron_1.ipcRenderer.invoke('offline:trigger-sync'),
        onSyncRequested: (callback) => {
            electron_1.ipcRenderer.on('offline:sync-requested', () => callback());
        },
        removeSyncListener: () => {
            electron_1.ipcRenderer.removeAllListeners('offline:sync-requested');
        },
        database: {
            initialize: (password, userId) => electron_1.ipcRenderer.invoke('db:initialize', password, userId),
            query: (sql, params = []) => electron_1.ipcRenderer.invoke('db:query', sql, params),
            transaction: (queries) => electron_1.ipcRenderer.invoke('db:transaction', queries),
            backup: (path) => electron_1.ipcRenderer.invoke('db:backup', path),
            vacuum: () => electron_1.ipcRenderer.invoke('db:vacuum'),
            getStats: () => electron_1.ipcRenderer.invoke('db:get-stats'),
            getPath: () => electron_1.ipcRenderer.invoke('db:get-path'),
            isReady: () => electron_1.ipcRenderer.invoke('db:is-ready'),
            close: () => electron_1.ipcRenderer.invoke('db:close'),
        },
        audit: {
            setContext: (orgId, userId, email) => electron_1.ipcRenderer.invoke('audit:set-context', orgId, userId, email),
            log: (action, table, recordId, oldData, newData) => electron_1.ipcRenderer.invoke('audit:log', action, table, recordId, oldData, newData),
            getUnsynced: (limit) => electron_1.ipcRenderer.invoke('audit:get-unsynced', limit),
            markSynced: (ids) => electron_1.ipcRenderer.invoke('audit:mark-synced', ids),
        },
        backup: {
            runNow: () => electron_1.ipcRenderer.invoke('backup:run-now'),
            list: () => electron_1.ipcRenderer.invoke('backup:list'),
            restore: (backupPath) => electron_1.ipcRenderer.invoke('backup:restore', backupPath),
            getConfig: () => electron_1.ipcRenderer.invoke('backup:get-config'),
            setConfig: (config) => electron_1.ipcRenderer.invoke('backup:set-config', config),
            onCompleted: (callback) => {
                electron_1.ipcRenderer.on('backup:completed', (_event, result) => callback(result));
            },
            removeCompletedListener: () => {
                electron_1.ipcRenderer.removeAllListeners('backup:completed');
            },
        },
    },
    // ===== Document printing (HTML→PDF / silent print) =====
    print: {
        html: (html, options) => electron_1.ipcRenderer.invoke('print:html', html, options),
        silent: (html, printerName) => electron_1.ipcRenderer.invoke('print:silent', html, printerName),
        getPrinters: () => electron_1.ipcRenderer.invoke('print:get-printers'),
        toPDF: (html, savePath) => electron_1.ipcRenderer.invoke('print:to-pdf', html, savePath),
    },
    // ===== System tray =====
    tray: {
        updateStatus: (status, info) => electron_1.ipcRenderer.invoke('tray:update-status', status, info),
    },
    // ===== ERP module manifest (online-only feature gating) =====
    erp: {
        onlineOnlyModules: ['crm', 'projects', 'timesheets', 'leave'],
        isOnlineOnlyModule: (path) => {
            const onlineModules = ['/crm', '/projects', '/timesheets', '/leave'];
            return onlineModules.some((mod) => path.startsWith(mod));
        },
    },
});
//# sourceMappingURL=preload.js.map