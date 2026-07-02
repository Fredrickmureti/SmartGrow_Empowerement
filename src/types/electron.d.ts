/**
 * Type definitions for the renderer-facing window.pos surface
 * exposed by electron/preload.ts (ADR-0014 Track H2).
 *
 * The legacy `window.electronAPI` surface has been removed; any reference
 * to it is now an ESLint error via `local/no-raw-hardware-ipc`. All
 * renderer code must call `window.pos.*` (or, for device IO, the
 * `hardwareClient` facade which routes to `window.pos.hardware.exec`).
 */

export interface PosHardwareExecCmd {
  role: string;
  op: string;
  payload?: unknown;
  idempotencyKey: string;
  maxAttempts?: number;
}

export interface PosHardwareExecResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  queueId?: number;
}

export interface PosHardwareEvent {
  type: string;
  deviceId?: string;
  role?: string;
  data?: unknown;
  ts: number;
}

export type HardwareTransportState = 'native' | 'unavailable' | 'degraded';

export interface HardwareCapabilitiesSnapshot {
  ok: boolean;
  runtime: 'electron';
  platform: string;
  preloadBuild: string;
  transports: {
    usb: HardwareTransportState;
    serial: HardwareTransportState;
    hid: HardwareTransportState;
    network: HardwareTransportState;
    cups: HardwareTransportState;
    bluetooth: HardwareTransportState;
  };
  ops: string[];
}

export interface DiscoveredUsb {
  transport: 'usb';
  vendorId: number;
  productId: number;
  vendorIdHex: string;
  productIdHex: string;
  busNumber?: number;
  deviceAddress?: number;
  manufacturer?: string | null;
  product?: string | null;
  serialNumber?: string | null;
}
export interface DiscoveredSerial {
  transport: 'serial';
  path: string;
  manufacturer?: string | null;
  serialNumber?: string | null;
  pnpId?: string | null;
  vendorId?: string | null;
  productId?: string | null;
}
export interface DiscoverySnapshot {
  ok: boolean;
  error?: string;
  ranAt: number;
  usb: DiscoveredUsb[];
  serial: DiscoveredSerial[];
  network: {
    candidates: Array<{ transport: 'network'; host: string; port: number; name?: string | null }>;
    notImplemented: true;
    note: string;
  };
}

export interface PosHardwareAPI {
  exec: (cmd: PosHardwareExecCmd) => Promise<PosHardwareExecResult>;
  subscribe: (callback: (event: PosHardwareEvent) => void) => () => void;
  /** Wave 9d — main-process capability probe; never opens devices. */
  capabilities: () => Promise<HardwareCapabilitiesSnapshot>;
  /** Phase 2 — native device discovery (USB + serial + network placeholder). */
  discover: () => Promise<DiscoverySnapshot>;
  /** Phase 2 — TCP reachability probe for manual network-printer add. */
  probeHost: (host: string, port: number, timeoutMs?: number) =>
    Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
}

export interface PosSaleAPI {
  committed: (payload: { saleId: string; receipt?: unknown; drawer?: unknown; display?: unknown; gl?: unknown }) =>
    Promise<{ ok: boolean; queued?: boolean; error?: string }>;
}

export interface PosDevicesAPI {
  list: () => Promise<{ ok: boolean; rows?: Array<{ id: number; terminal_id: string | null; role: string; transport: string; driver: string; config_json: string; enabled: number; created_at: number; updated_at: number }>; error?: string }>;
  upsert: (input: {
    terminalId?: string | null;
    role: string;
    transport: 'usb' | 'serial' | 'network' | 'bluetooth' | 'cups' | 'winspool' | 'browser';
    driver: string;
    config: Record<string, unknown>;
    enabled?: boolean;
  }) => Promise<{ ok: boolean; row?: unknown; error?: string }>;
  remove: (id: number) => Promise<{ ok: boolean; removed?: boolean; error?: string }>;
  setTerminal: (terminalId: string | null) => Promise<{ ok: boolean; terminalId: string | null }>;
  status: () => Promise<{ ok: boolean; statuses?: Array<{ role: string; transport: string; driver: string; connected: boolean }>; error?: string }>;
  reconnect: (role: string) => Promise<{ ok: boolean; error?: string }>;
}

// Track B-UI — Bluetooth pairing surface. Never carries plaintext link keys.
export interface SafeBtPairingRow {
  device_id: string;
  mac: string;
  name: string | null;
  role: string;
  auto_reconnect: 0 | 1;
  paired_at: number;
  last_connected_at: number | null;
  state: string;
}
export type BtIpcResult<T = void> = { ok: true; data?: T } | { ok: false; error: string };
export interface PosBluetoothAPI {
  radioAvailable: () => Promise<{ ok: boolean }>;
  list: () => Promise<BtIpcResult<SafeBtPairingRow[]>>;
  pair: (input: { deviceId: string; mac: string; name?: string | null; role: string; autoReconnect?: boolean }) => Promise<BtIpcResult>;
  unpair: (deviceId: string) => Promise<BtIpcResult>;
  connect: (deviceId: string) => Promise<BtIpcResult>;
  disconnect: (deviceId: string) => Promise<BtIpcResult>;
  health: (deviceId: string) => Promise<BtIpcResult<{ ok: boolean; latencyMs: number; state: string; error?: string }>>;
}

export interface PosAppWindowAPI {
  getSize: () => Promise<{ width: number; height: number }>;
  onResize: (callback: (width: number, height: number) => void) => void;
  removeResizeListener: () => void;
}

export interface PosAppCustomerDisplayAPI {
  getDisplays: () => Promise<Array<{ id: number; label: string; primary: boolean; bounds?: { x: number; y: number; width: number; height: number } }>>;
  open: (displayIndex: number, fullscreen: boolean) => Promise<{ success: boolean; error?: string }>;
  close: () => Promise<{ success: boolean; error?: string }>;
  update: (data: unknown) => Promise<{ success: boolean; error?: string }>;
  isOpen: () => Promise<boolean>;
}

export interface PosAppAPI {
  quit: () => Promise<void>;
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  enableKiosk: () => Promise<void>;
  disableKiosk: () => Promise<void>;
  getVersion: () => Promise<string>;
  getPath: (name: string) => Promise<string>;
  window: PosAppWindowAPI;
  customerDisplay: PosAppCustomerDisplayAPI;
}

export interface PosNetworkAPI {
  checkOnline: () => Promise<boolean>;
  getStatus: () => Promise<boolean>;
  onStatusChange: (callback: (isOnline: boolean) => void) => void;
  onRestored: (callback: () => void) => void;
  removeAllListeners: () => void;
}

export interface PosSecureStorageAPI {
  save: (key: string, data: string) => Promise<{ success: boolean; encrypted?: boolean; error?: string }>;
  load: (key: string) => Promise<{ success: boolean; data: string | null; error?: string }>;
  delete: (key: string) => Promise<{ success: boolean; error?: string }>;
  clearAll: () => Promise<{ success: boolean; error?: string }>;
}

export interface PosKeyManagerAPI {
  hashPassword: (password: string) => Promise<string>;
  verifyPassword: (password: string, hash: string) => Promise<boolean>;
  hashPin: (pin: string) => Promise<string>;
  verifyPin: (pin: string, hash: string) => Promise<boolean>;
}

export interface PosStorageAPI {
  secureStorage: PosSecureStorageAPI;
  keyManager: PosKeyManagerAPI;
}

export interface PosDatabaseAPI {
  initialize: (password: string, userId: string) => Promise<{ success: boolean; error?: string }>;
  query: (sql: string, params?: unknown[]) => Promise<{ success: boolean; data?: unknown[]; error?: string }>;
  transaction: (queries: Array<{ sql: string; params?: unknown[] }>) => Promise<{ success: boolean; error?: string }>;
  backup: (path: string) => Promise<{ success: boolean; error?: string }>;
  vacuum: () => Promise<{ success: boolean; error?: string }>;
  getStats: () => Promise<{ success: boolean; data?: { size: number; tableCount: number; pendingSyncCount: number; lastVacuum: string | null }; error?: string }>;
  getPath: () => Promise<string>;
  isReady: () => Promise<boolean>;
  close: () => Promise<{ success: boolean; error?: string }>;
}

export interface PosAuditAPI {
  setContext: (orgId: string, userId: string, email: string) => Promise<{ success: boolean }>;
  log: (action: string, table: string, recordId?: string, oldData?: unknown, newData?: unknown) => Promise<{ success: boolean }>;
  getUnsynced: (limit?: number) => Promise<unknown[]>;
  markSynced: (ids: string[]) => Promise<{ success: boolean }>;
}

export interface PosBackupAPI {
  runNow: () => Promise<{ success: boolean; path?: string; error?: string; timestamp?: string }>;
  list: () => Promise<Array<{ path: string; filename: string; date: string; size: number }>>;
  restore: (backupPath: string) => Promise<{ success: boolean; error?: string }>;
  getConfig: () => Promise<{ enabled: boolean; intervalHours: number; maxBackups: number; backupPath: string }>;
  setConfig: (config: object) => Promise<{ success: boolean }>;
  onCompleted: (callback: (result: { success: boolean; path?: string; timestamp?: string }) => void) => void;
  removeCompletedListener: () => void;
}

export interface PosOfflineAPI {
  getSyncStatus: () => Promise<{ lastSyncAt: string | null; pendingCount: number; failedCount: number }>;
  updateSyncStatus: (status: { lastSyncAt?: string; pendingCount?: number; failedCount?: number }) =>
    Promise<{ lastSyncAt: string | null; pendingCount: number; failedCount: number }>;
  triggerSync: () => Promise<{ success: boolean }>;
  onSyncRequested: (callback: () => void) => void;
  removeSyncListener: () => void;
  database: PosDatabaseAPI;
  audit: PosAuditAPI;
  backup: PosBackupAPI;
}

export interface PosPrintAPI {
  html: (html: string, options?: object) => Promise<{ success: boolean; error?: string }>;
  silent: (html: string, printerName?: string) => Promise<{ success: boolean; error?: string }>;
  getPrinters: () => Promise<Array<{
    name: string;
    displayName: string;
    description: string;
    status: number;
    isDefault: boolean;
  }>>;
  toPDF: (html: string, savePath: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  /** ADR-0015 — print an existing PDF byte stream via Chromium's PDF plugin. */
  pdfBytes: (
    bytes: Uint8Array,
    options?: { silent?: boolean; deviceName?: string },
  ) => Promise<{ success: boolean; error?: string }>;
}

/** ADR-0015 — Electron-safe document preview surface. */
export interface PosPreviewAPI {
  openPdf: (
    bytes: Uint8Array,
    opts?: { title?: string; filename?: string },
  ) => Promise<{ success: boolean; path?: string; error?: string }>;
}

export interface PosTrayAPI {
  updateStatus: (status: 'online' | 'offline' | 'syncing' | 'warning', info?: string) =>
    Promise<{ success: boolean }>;
}

export interface PosErpAPI {
  onlineOnlyModules: string[];
  isOnlineOnlyModule: (path: string) => boolean;
}

export interface PosAPI {
  isElectron: boolean;
  platform: string;
  hardware: PosHardwareAPI;
  sale: PosSaleAPI;
  devices: PosDevicesAPI;
  bluetooth: PosBluetoothAPI;
  app: PosAppAPI;
  network: PosNetworkAPI;
  storage: PosStorageAPI;
  offline: PosOfflineAPI;
  print: PosPrintAPI;
  preview: PosPreviewAPI;
  tray: PosTrayAPI;
  erp: PosErpAPI;
}

declare global {
  interface Window {
    pos?: PosAPI;
  }
}

export {};
