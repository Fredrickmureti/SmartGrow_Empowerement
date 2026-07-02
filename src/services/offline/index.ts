/**
 * Offline Services Export
 */

export { offlineStorage, STORES } from "./OfflineStorageService";
export type { QueuedTransaction, SyncMeta } from "./OfflineStorageService";

export { transactionQueue } from "./TransactionQueue";
export type { OfflineTransactionData, FailedTransactionInfo } from "./TransactionQueue";

export { syncManager } from "./SyncManager";

export { offlineAuthService } from "./OfflineAuthService";

export { backgroundSyncManager } from "./BackgroundSyncManager";

export { extendedOfflineStorage, EXTENDED_STORES } from "./ExtendedOfflineStorage";
export type {
  CachedRegister,
  CachedShift,
  CachedTaxRate,
  CachedPaymentMethod,
  CachedOrganization,
  CachedBusiness,
} from "./ExtendedOfflineStorage";

// SQLite-based services (for Electron desktop app)
export * as SQLiteBridge from "./SQLiteBridge";
export { sqliteAuthService } from "./SQLiteAuthService";
export { terminalLockService } from "./TerminalLockService";
export { sqliteSyncManager } from "./SQLiteSyncManager";
