/**
 * SQLite Bridge for React
 * Provides type-safe access to Electron SQLite database from React components
 */

import type { PosAPI } from '@/types/electron';
import { identityCodeCandidates, isIdentifierLive } from '@/lib/gs1/identityCodes';

export interface QueryResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  rowsAffected?: number;
}

export interface DatabaseStats {
  size: number;
  tableCount: number;
  pendingSyncCount: number;
  lastVacuum: string | null;
}

export interface SyncStatus {
  pendingCount: number;
  failedCount: number;
  lastSyncAt: string | null;
  isSyncing: boolean;
}

/**
 * Check if running in Electron
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.pos?.isElectron;
}

/**
 * Get the capability-scoped renderer surface (Track H2).
 */
function getPos(): PosAPI {
  if (!isElectron()) {
    throw new Error('SQLite is only available in Electron');
  }
  return window.pos as PosAPI;
}

/**
 * Initialize the SQLite database
 */
export async function initializeDatabase(password: string, userId: string): Promise<QueryResult<void>> {
  const api = getPos();
  return api.offline.database.initialize(password, userId);
}

/**
 * Check if database is ready
 */
export async function isDatabaseReady(): Promise<boolean> {
  if (!isElectron()) return false;
  try {
    const api = getPos();
    return await api.offline.database.isReady();
  } catch {
    return false;
  }
}

/**
 * Execute a SQL query
 */
export async function executeQuery<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T[]>> {
  const api = getPos();
  return api.offline.database.query(sql, params) as Promise<QueryResult<T[]>>;
}

/**
 * Execute multiple queries in a transaction
 */
export async function executeTransaction(
  queries: Array<{ sql: string; params?: unknown[] }>
): Promise<QueryResult<void>> {
  const api = getPos();
  return api.offline.database.transaction(queries);
}

/**
 * Get database statistics
 */
export async function getDatabaseStats(): Promise<QueryResult<DatabaseStats>> {
  const api = getPos();
  return api.offline.database.getStats();
}

/**
 * Get database file path
 */
export async function getDatabasePath(): Promise<string> {
  const api = getPos();
  return api.offline.database.getPath();
}

/**
 * Create a database backup
 */
export async function backupDatabase(path: string): Promise<QueryResult<void>> {
  const api = getPos();
  return api.offline.database.backup(path);
}

/**
 * Optimize database
 */
export async function vacuumDatabase(): Promise<QueryResult<void>> {
  const api = getPos();
  return api.offline.database.vacuum();
}

/**
 * Close the database
 */
export async function closeDatabase(): Promise<QueryResult<void>> {
  const api = getPos();
  return api.offline.database.close();
}

// ============ Key Management ============

/**
 * Hash a password for storage
 */
export async function hashPassword(password: string): Promise<string> {
  const api = getPos();
  return api.storage.keyManager.hashPassword(password);
}

/**
 * Verify a password against stored hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const api = getPos();
  return api.storage.keyManager.verifyPassword(password, hash);
}

/**
 * Hash a PIN for storage
 */
export async function hashPin(pin: string): Promise<string> {
  const api = getPos();
  return api.storage.keyManager.hashPin(pin);
}

/**
 * Verify a PIN against stored hash
 */
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  const api = getPos();
  return api.storage.keyManager.verifyPin(pin, hash);
}

// ============ Audit Logging ============

/**
 * Set the audit context for logging
 */
export async function setAuditContext(orgId: string, userId: string, email: string): Promise<void> {
  const api = getPos();
  await api.offline.audit.setContext(orgId, userId, email);
}

/**
 * Log an audit entry
 */
export async function logAuditEntry(
  action: string,
  table: string,
  recordId?: string,
  oldData?: unknown,
  newData?: unknown
): Promise<void> {
  const api = getPos();
  await api.offline.audit.log(action, table, recordId, oldData, newData);
}

// ============ Helper Functions ============

/**
 * Get products from local cache
 */
export async function getCachedProducts(organizationId: string): Promise<any[]> {
  const result = await executeQuery<any>(
    'SELECT * FROM products WHERE organization_id = ? AND is_active = 1 ORDER BY name',
    [organizationId]
  );
  return result.success ? result.data || [] : [];
}

/**
 * Get customers from local cache
 */
export async function getCachedCustomers(organizationId: string): Promise<any[]> {
  const result = await executeQuery<any>(
    'SELECT * FROM contacts WHERE organization_id = ? AND type IN (?, ?) AND is_active = 1 ORDER BY name',
    [organizationId, 'customer', 'both']
  );
  return result.success ? result.data || [] : [];
}

/**
 * Search products by name, SKU, or any code in `product_identifiers`.
 *
 * Stage 2 of the POS scanner re-audit retired direct reads of the legacy
 * `products.barcode` column in favor of the canonical `product_identifiers`
 * table. The legacy column still exists in the local SQLite schema for
 * backward-compat with older Electron caches, but it is never queried at
 * runtime — `product_identifiers` is the only authoritative source.
 */
export async function searchProducts(organizationId: string, query: string): Promise<any[]> {
  const searchTerm = `%${query}%`;
  const result = await executeQuery<any>(
    `SELECT p.* FROM products p
       LEFT JOIN product_identifiers pi ON pi.product_id = p.id
     WHERE p.organization_id = ?
       AND p.is_active = 1
       AND (p.name LIKE ? OR p.sku LIKE ? OR pi.code LIKE ?)
     GROUP BY p.id
     ORDER BY p.name
     LIMIT 50`,
    [organizationId, searchTerm, searchTerm, searchTerm]
  );
  return result.success ? result.data || [] : [];
}

/**
 * Offline identity resolution (ADR-0110 Phase 6).
 *
 * Parity with the SQL resolver `resolve_product_identity`:
 *   - candidates come from the ONE shared grammar
 *     (`identityCodeCandidates`) so `code_norm` normalisation, the GS1
 *     AI (01) GTIN and the GTIN-8/12/13/14 padding family behave the
 *     same online and offline;
 *   - lifecycle is enforced (`status`/`valid_from`/`valid_to`) so a
 *     retired or not-yet-live code cannot resolve on a disconnected lane;
 *   - more than one distinct product ⇒ `ambiguous`, never a silent pick.
 */
export type OfflineIdentityStatus = "resolved" | "ambiguous" | "not_found" | "error";

export interface OfflineIdentityDecision {
  status: OfflineIdentityStatus;
  product: any | null;
  matchCount: number;
  /** The identifier row that matched, when exactly one product matched. */
  identifier: any | null;
}

export async function resolveProductIdentityOffline(
  organizationId: string,
  code: string,
): Promise<OfflineIdentityDecision> {
  const candidates = identityCodeCandidates(code);
  if (candidates.length === 0) {
    return { status: "not_found", product: null, matchCount: 0, identifier: null };
  }

  const placeholders = candidates.map(() => "?").join(",");
  const result = await executeQuery<any>(
    `SELECT p.*,
            pi.id          AS identifier_id,
            pi.code        AS identifier_code,
            pi.kind        AS identifier_kind,
            pi.status      AS identifier_status,
            pi.valid_from  AS identifier_valid_from,
            pi.valid_to    AS identifier_valid_to,
            pi.packaging_id,
            pi.qty_in_base_uom
       FROM products p
       INNER JOIN product_identifiers pi ON pi.product_id = p.id
     WHERE p.organization_id = ?
       AND p.is_active = 1
       AND upper(trim(pi.code)) IN (${placeholders})
     LIMIT 50`,
    [organizationId, ...candidates],
  );
  if (!result.success) {
    return { status: "error", product: null, matchCount: 0, identifier: null };
  }

  const live = (result.data || []).filter((r) =>
    isIdentifierLive({
      status: r.identifier_status,
      valid_from: r.identifier_valid_from,
      valid_to: r.identifier_valid_to,
    }),
  );
  const distinct = Array.from(new Set(live.map((r) => r.id)));
  if (distinct.length === 0) {
    return { status: "not_found", product: null, matchCount: 0, identifier: null };
  }
  if (distinct.length > 1) {
    return { status: "ambiguous", product: null, matchCount: distinct.length, identifier: null };
  }

  // Prefer the candidate that matched most specifically (candidates are
  // ordered most-specific-first) so a level scan keeps its packaging row.
  const best =
    candidates
      .map((c) => live.find((r) => (r.identifier_code ?? "").trim().toUpperCase() === c))
      .find(Boolean) ?? live[0];

  return { status: "resolved", product: best, matchCount: 1, identifier: best };
}

/**
 * Get a product by any identifier (GTIN/SKU/PLU/alias).
 * Thin wrapper over `resolveProductIdentityOffline` — returns the product
 * only on an unambiguous, lifecycle-valid match. `null` means callers must
 * fall through to the online `resolve_product_identity` RPC.
 */
export async function getProductByBarcode(organizationId: string, barcode: string): Promise<any | null> {
  const decision = await resolveProductIdentityOffline(organizationId, barcode);
  return decision.status === "resolved" ? decision.product : null;
}


/**
 * Get open shift for register
 */
export async function getOpenShift(organizationId: string, registerId: string): Promise<any | null> {
  const result = await executeQuery<any>(
    `SELECT * FROM pos_shifts 
     WHERE organization_id = ? AND register_id = ? AND status = 'open'
     ORDER BY opened_at DESC LIMIT 1`,
    [organizationId, registerId]
  );
  return result.success && result.data?.length ? result.data[0] : null;
}

/**
 * Get today's transactions
 */
export async function getTodayTransactions(organizationId: string, shiftId?: string): Promise<any[]> {
  const today = new Date().toISOString().split('T')[0];
  
  let sql = `
    SELECT * FROM pos_transactions 
    WHERE organization_id = ? 
      AND date(created_at) = date(?)
      AND status != 'voided'
  `;
  const params: unknown[] = [organizationId, today];
  
  if (shiftId) {
    sql += ' AND shift_id = ?';
    params.push(shiftId);
  }
  
  sql += ' ORDER BY created_at DESC';
  
  const result = await executeQuery<any>(sql, params);
  return result.success ? result.data || [] : [];
}

/**
 * Get pending sync count
 */
export async function getPendingSyncCount(): Promise<number> {
  const result = await executeQuery<{ count: number }>(`
    SELECT 
      (SELECT count(*) FROM pos_transactions WHERE sync_status IN ('pending', 'failed')) +
      (SELECT count(*) FROM pos_shifts WHERE sync_status IN ('pending', 'failed')) +
      (SELECT count(*) FROM pos_cash_movements WHERE sync_status IN ('pending', 'failed')) +
      (SELECT count(*) FROM pos_returns WHERE sync_status IN ('pending', 'failed'))
    as count
  `);
  return result.success && result.data?.length ? result.data[0].count : 0;
}

/**
 * Get held transactions
 */
export async function getHeldTransactions(organizationId: string): Promise<any[]> {
  const result = await executeQuery<any>(
    `SELECT * FROM held_transactions 
     WHERE organization_id = ? 
     ORDER BY held_at DESC`,
    [organizationId]
  );
  return result.success ? result.data || [] : [];
}

/**
 * Save held transaction
 */
export async function saveHeldTransaction(data: {
  id: string;
  organizationId: string;
  registerId?: string;
  shiftId?: string;
  customerId?: string;
  customerName?: string;
  items: unknown[];
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  total: number;
  notes?: string;
  heldBy?: string;
}): Promise<boolean> {
  const result = await executeQuery(
    `INSERT INTO held_transactions (
      id, organization_id, register_id, shift_id, customer_id, customer_name,
      items, subtotal, tax_amount, discount_amount, total, notes, held_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      data.organizationId,
      data.registerId,
      data.shiftId,
      data.customerId,
      data.customerName,
      JSON.stringify(data.items),
      data.subtotal,
      data.taxAmount,
      data.discountAmount,
      data.total,
      data.notes,
      data.heldBy,
    ]
  );
  return result.success;
}

/**
 * Delete held transaction
 */
export async function deleteHeldTransaction(id: string): Promise<boolean> {
  const result = await executeQuery('DELETE FROM held_transactions WHERE id = ?', [id]);
  return result.success;
}
