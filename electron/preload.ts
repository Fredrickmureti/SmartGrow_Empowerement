import { contextBridge, ipcRenderer } from 'electron';
import { createHash, createHmac, randomBytes } from 'node:crypto';

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
let cachedSecret: string | null = null;
async function getSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const s = await ipcRenderer.invoke('pos:session:get-secret');
  if (typeof s !== 'string' || s.length < 32) {
    throw new Error('pos: failed to acquire session secret');
  }
  cachedSecret = s;
  return s;
}

function sign(secret: string, ts: string, payloadJson: string, nonce: string): string {
  // Match NetworkTransport.sign — `${ts}.${sha256(body)}` where body
  // commits to payload + nonce so replay across nonces is impossible.
  const bodyHash = createHash('sha256').update(payloadJson + '|' + nonce).digest('hex');
  return createHmac('sha256', secret).update(`${ts}.${bodyHash}`).digest('hex');
}

async function envelope<T>(payload: T): Promise<{ payload: T; ts: string; nonce: string; sig: string }> {
  const secret = await getSecret();
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(12).toString('hex');
  const payloadJson = JSON.stringify(payload ?? null);
  const sig = sign(secret, ts, payloadJson, nonce);
  return { payload, ts, nonce, sig };
}

contextBridge.exposeInMainWorld('pos', {
  isElectron: true,
  platform: process.platform,

  // Phase 1 diagnostics — fingerprint so the renderer can prove which
  // preload bundle is actually loaded inside the packaged app. If the
  // diagnostics page shows `preloadBuild: 'unknown'` or an older marker
  // than the renderer, the desktop binary is stale and must be repackaged.
  preloadBuild: '11-2026-06-11',
  preloadFeatures: ['hardware', 'devices', 'sale', 'bluetooth', 'app', 'network', 'storage', 'offline', 'print', 'tray', 'erp', 'queue'],


  // ===== Hardware (Track H1 + H3 envelope signing) =====
  hardware: {
    exec: async (cmd: { role: string; op: string; payload?: unknown; idempotencyKey: string; maxAttempts?: number }) =>
      ipcRenderer.invoke('pos:exec', await envelope(cmd)),
    subscribe: (callback: (event: { type: string; deviceId?: string; role?: string; data?: unknown; ts: number }) => void) => {
      const listener = (_e: unknown, event: { type: string; deviceId?: string; role?: string; data?: unknown; ts: number }) => callback(event);
      ipcRenderer.on('pos:event', listener);
      return () => ipcRenderer.removeListener('pos:event', listener);
    },
    /**
     * Wave 9d — runtime capability probe. Returns the live transport /
     * op matrix as seen from the main process. The renderer's
     * `hardwareClient.runtimeCapability()` consumes this so the Runtime
     * card on /platform/hardware/devices can honestly report degraded
     * capabilities instead of static copy.
     */
    capabilities: () => ipcRenderer.invoke('pos:hardware:capabilities'),
    /**
     * Phase 2 — native discovery. Returns USB + serial + (placeholder)
     * network candidates the operator can promote into an assignment.
     * Read-only; never opens a device.
     */
    discover: () => ipcRenderer.invoke('pos:hardware:discover'),
    /** Phase 2 — TCP reachability probe used by manual-add for network printers. */
    probeHost: (host: string, port: number, timeoutMs?: number) =>
      ipcRenderer.invoke('pos:hardware:probe-host', { host, port, timeoutMs }),
  },
  sale: {
    committed: async (payload: { saleId: string; receipt?: unknown; drawer?: unknown; display?: unknown; gl?: unknown }) =>
      ipcRenderer.invoke('pos:sale-committed', await envelope(payload)),
  },
  devices: {
    list: () => ipcRenderer.invoke('pos:devices:list'),
    upsert: (input: {
      terminalId?: string | null;
      role: string;
      transport: 'usb' | 'serial' | 'network' | 'bluetooth' | 'cups' | 'winspool' | 'browser';
      driver: string;
      config: Record<string, unknown>;
      enabled?: boolean;
    }) => ipcRenderer.invoke('pos:devices:upsert', input),
    remove: (id: number) => ipcRenderer.invoke('pos:devices:remove', id),
    setTerminal: (terminalId: string | null) => ipcRenderer.invoke('pos:devices:set-terminal', terminalId),
    status: () => ipcRenderer.invoke('pos:devices:status'),
    reconnect: (role: string) => ipcRenderer.invoke('pos:devices:reconnect', role),
  },

  // ===== Wave 11 R2: dead-letter queue inspection =====
  // Operator-visible failed commands; surfaced in HardwareDiagnostics so
  // missed prints stop being a silent failure mode.
  queue: {
    listDead: () => ipcRenderer.invoke('pos:queue:list-dead'),
    replayDead: (id: number) => ipcRenderer.invoke('pos:queue:replay-dead', id),
    discardDead: (id: number) => ipcRenderer.invoke('pos:queue:discard-dead', id),
  },


  // ===== Bluetooth pairings (Track B-UI) =====
  // Manager calls; never returns plaintext link keys.
  bluetooth: {
    radioAvailable: () => ipcRenderer.invoke('pos:bluetooth:radio-available'),
    list: () => ipcRenderer.invoke('pos:bluetooth:list'),
    pair: (input: { deviceId: string; mac: string; name?: string | null; role: string; autoReconnect?: boolean }) =>
      ipcRenderer.invoke('pos:bluetooth:pair', input),
    unpair: (deviceId: string) => ipcRenderer.invoke('pos:bluetooth:unpair', deviceId),
    connect: (deviceId: string) => ipcRenderer.invoke('pos:bluetooth:connect', deviceId),
    disconnect: (deviceId: string) => ipcRenderer.invoke('pos:bluetooth:disconnect', deviceId),
    health: (deviceId: string) => ipcRenderer.invoke('pos:bluetooth:health', deviceId),
  },


  // ===== App lifecycle & window orchestration =====
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    minimize: () => ipcRenderer.invoke('app:minimize'),
    maximize: () => ipcRenderer.invoke('app:maximize'),
    enableKiosk: () => ipcRenderer.invoke('app:enable-kiosk'),
    disableKiosk: () => ipcRenderer.invoke('app:disable-kiosk'),
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    getPath: (name: string) => ipcRenderer.invoke('app:get-path', name),

    window: {
      getSize: () => ipcRenderer.invoke('window:get-size'),
      onResize: (callback: (width: number, height: number) => void) => {
        ipcRenderer.on('window:resize', (_event, width, height) => callback(width, height));
      },
      removeResizeListener: () => {
        ipcRenderer.removeAllListeners('window:resize');
      },
    },

    // Customer display is secondary-BrowserWindow orchestration, not device IO.
    // Device-IO updates flow through pos.hardware.subscribe('customer_display:update').
    customerDisplay: {
      getDisplays: () => ipcRenderer.invoke('customer-display:get-displays'),
      open: (displayIndex: number, fullscreen: boolean) =>
        ipcRenderer.invoke('customer-display:open', displayIndex, fullscreen),
      close: () => ipcRenderer.invoke('customer-display:close'),
      update: (data: unknown) => ipcRenderer.invoke('customer-display:update', data),
      isOpen: () => ipcRenderer.invoke('customer-display:is-open'),
    },
  },

  // ===== Kiosk network status =====
  network: {
    checkOnline: () => ipcRenderer.invoke('network:check-online'),
    getStatus: () => ipcRenderer.invoke('network:get-status'),
    onStatusChange: (callback: (isOnline: boolean) => void) => {
      ipcRenderer.on('network:status-change', (_event, isOnline) => callback(isOnline));
    },
    onRestored: (callback: () => void) => {
      ipcRenderer.on('network:restored', () => callback());
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('network:status-change');
      ipcRenderer.removeAllListeners('network:restored');
    },
  },

  // ===== Encrypted local storage =====
  storage: {
    secureStorage: {
      save: (key: string, data: string) => ipcRenderer.invoke('secure-storage:save', key, data),
      load: (key: string) => ipcRenderer.invoke('secure-storage:load', key),
      delete: (key: string) => ipcRenderer.invoke('secure-storage:delete', key),
      clearAll: () => ipcRenderer.invoke('secure-storage:clear-all'),
    },
    keyManager: {
      hashPassword: (password: string) => ipcRenderer.invoke('key:hash-password', password),
      verifyPassword: (password: string, hash: string) =>
        ipcRenderer.invoke('key:verify-password', password, hash),
      hashPin: (pin: string) => ipcRenderer.invoke('key:hash-pin', pin),
      verifyPin: (pin: string, hash: string) =>
        ipcRenderer.invoke('key:verify-pin', pin, hash),
    },
  },

  // ===== Offline / local-DB concerns =====
  offline: {
    getSyncStatus: () => ipcRenderer.invoke('offline:get-sync-status'),
    updateSyncStatus: (status: { lastSyncAt?: string; pendingCount?: number; failedCount?: number }) =>
      ipcRenderer.invoke('offline:update-sync-status', status),
    triggerSync: () => ipcRenderer.invoke('offline:trigger-sync'),
    onSyncRequested: (callback: () => void) => {
      ipcRenderer.on('offline:sync-requested', () => callback());
    },
    removeSyncListener: () => {
      ipcRenderer.removeAllListeners('offline:sync-requested');
    },

    database: {
      initialize: (password: string, userId: string) =>
        ipcRenderer.invoke('db:initialize', password, userId),
      query: (sql: string, params: unknown[] = []) =>
        ipcRenderer.invoke('db:query', sql, params),
      transaction: (queries: Array<{ sql: string; params?: unknown[] }>) =>
        ipcRenderer.invoke('db:transaction', queries),
      backup: (path: string) => ipcRenderer.invoke('db:backup', path),
      vacuum: () => ipcRenderer.invoke('db:vacuum'),
      getStats: () => ipcRenderer.invoke('db:get-stats'),
      getPath: () => ipcRenderer.invoke('db:get-path'),
      isReady: () => ipcRenderer.invoke('db:is-ready'),
      close: () => ipcRenderer.invoke('db:close'),
    },

    audit: {
      setContext: (orgId: string, userId: string, email: string) =>
        ipcRenderer.invoke('audit:set-context', orgId, userId, email),
      log: (action: string, table: string, recordId?: string, oldData?: unknown, newData?: unknown) =>
        ipcRenderer.invoke('audit:log', action, table, recordId, oldData, newData),
      getUnsynced: (limit?: number) => ipcRenderer.invoke('audit:get-unsynced', limit),
      markSynced: (ids: string[]) => ipcRenderer.invoke('audit:mark-synced', ids),
    },

    backup: {
      runNow: () => ipcRenderer.invoke('backup:run-now'),
      list: () => ipcRenderer.invoke('backup:list'),
      restore: (backupPath: string) => ipcRenderer.invoke('backup:restore', backupPath),
      getConfig: () => ipcRenderer.invoke('backup:get-config'),
      setConfig: (config: object) => ipcRenderer.invoke('backup:set-config', config),
      onCompleted: (callback: (result: { success: boolean; path?: string; timestamp?: string }) => void) => {
        ipcRenderer.on('backup:completed', (_event, result) => callback(result));
      },
      removeCompletedListener: () => {
        ipcRenderer.removeAllListeners('backup:completed');
      },
    },
  },

  // ===== Document printing (HTML→PDF / silent print) =====
  print: {
    html: (html: string, options?: object) => ipcRenderer.invoke('print:html', html, options),
    silent: (html: string, printerName?: string) => ipcRenderer.invoke('print:silent', html, printerName),
    getPrinters: () => ipcRenderer.invoke('print:get-printers'),
    toPDF: (html: string, savePath: string) => ipcRenderer.invoke('print:to-pdf', html, savePath),
    // ADR-0015 — print an existing PDF byte stream through Chromium's
    // native viewer (lifecycle-supervised hidden window in main).
    pdfBytes: (bytes: Uint8Array, options?: { silent?: boolean; deviceName?: string }) =>
      ipcRenderer.invoke('print:pdf-bytes', { bytes, ...(options ?? {}) }),
  },

  // ===== Document preview (ADR-0015 Electron-safe surface) =====
  preview: {
    openPdf: (bytes: Uint8Array, opts?: { title?: string; filename?: string }) =>
      ipcRenderer.invoke('preview:open-pdf', { bytes, ...(opts ?? {}) }),
  },

  // ===== System tray =====
  tray: {
    updateStatus: (status: 'online' | 'offline' | 'syncing' | 'warning', info?: string) =>
      ipcRenderer.invoke('tray:update-status', status, info),
  },

  // ===== ERP module manifest (online-only feature gating) =====
  erp: {
    onlineOnlyModules: ['crm', 'projects', 'timesheets', 'leave'],
    isOnlineOnlyModule: (path: string) => {
      const onlineModules = ['/crm', '/projects', '/timesheets', '/leave'];
      return onlineModules.some((mod) => path.startsWith(mod));
    },
  },
});
