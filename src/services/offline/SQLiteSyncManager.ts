/**
 * SQLite Sync Manager for React
 * Manages synchronization between local SQLite and Supabase
 */

import { supabase } from '@/integrations/supabase/client';
import {
  openSession as openPaymentSession,
  recordTender as recordPaymentTender,
  commitSession as commitPaymentSession,
  type PosTenderKind,
} from '@/lib/pos/paymentSessionClient';
import {
  isElectron,
  isDatabaseReady,
  executeQuery,
  executeTransaction,
  getPendingSyncCount,
} from './SQLiteBridge';
import { toast } from 'sonner';

export interface SyncProgress {
  phase: 'idle' | 'pulling' | 'pushing' | 'complete' | 'error';
  table?: string;
  progress: number;
  total: number;
  message: string;
}

export interface SyncResult {
  success: boolean;
  pulled: number;
  pushed: number;
  failed: number;
  conflicts: number;
  duration: number;
  error?: string;
}

type ProgressCallback = (progress: SyncProgress) => void;

class SQLiteSyncManager {
  private isSyncing = false;
  private organizationId: string | null = null;
  private businessId: string | null = null;
  private branchId: string | null = null;
  private progressCallbacks: Set<ProgressCallback> = new Set();
  private syncInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Set the organization + business + optional branch for sync. When the
   * active company changes we wipe the local cache to prevent sister-company
   * rows from leaking into the offline view on the same device.
   */
  setScope(orgId: string, businessId: string, branchId?: string | null): void {
    const changed = this.businessId !== businessId || this.organizationId !== orgId;
    this.organizationId = orgId;
    this.businessId = businessId;
    this.branchId = branchId ?? null;
    if (changed) {
      void this.wipeLocalCache().catch((e) =>
        console.warn('[SQLiteSyncManager] Cache wipe on scope change failed:', e)
      );
    }
  }

  /** @deprecated use setScope(orgId, businessId) — org-only scope leaks cross-company data offline. */
  setOrganizationId(orgId: string): void {
    this.organizationId = orgId;
  }

  private async wipeLocalCache(): Promise<void> {
    const tables = [
      'products', 'contacts', 'branches', 'user_branch_assignments',
      'pos_registers', 'pos_cashiers', 'tax_rates', 'pos_discounts',
    ];
    await executeTransaction(
      tables.map((t) => ({ sql: `DELETE FROM ${t}`, params: [] }))
        .concat([{ sql: `DELETE FROM sync_metadata`, params: [] }])
    );
  }


  /**
   * Subscribe to sync progress updates
   */
  onProgress(callback: ProgressCallback): () => void {
    this.progressCallbacks.add(callback);
    return () => this.progressCallbacks.delete(callback);
  }

  /**
   * Emit progress update
   */
  private emitProgress(progress: SyncProgress): void {
    this.progressCallbacks.forEach(cb => cb(progress));
  }

  /**
   * Perform a full sync
   */
  async fullSync(): Promise<SyncResult> {
    if (!isElectron() || !this.organizationId) {
      return { success: false, pulled: 0, pushed: 0, failed: 0, conflicts: 0, duration: 0, error: 'Not in Electron or no org ID' };
    }

    if (this.isSyncing) {
      return { success: false, pulled: 0, pushed: 0, failed: 0, conflicts: 0, duration: 0, error: 'Sync already in progress' };
    }

    const ready = await isDatabaseReady();
    if (!ready) {
      return { success: false, pulled: 0, pushed: 0, failed: 0, conflicts: 0, duration: 0, error: 'Database not ready' };
    }

    const startTime = Date.now();
    this.isSyncing = true;
    
    const result: SyncResult = {
      success: true,
      pulled: 0,
      pushed: 0,
      failed: 0,
      conflicts: 0,
      duration: 0,
    };

    try {
      // Pull reference data
      this.emitProgress({ phase: 'pulling', progress: 0, total: 8, message: 'Syncing products...' });
      result.pulled += await this.pullTable('products', 'updated_at');
      
      this.emitProgress({ phase: 'pulling', progress: 1, total: 8, message: 'Syncing contacts...' });
      result.pulled += await this.pullTable('contacts', 'updated_at');
      
      this.emitProgress({ phase: 'pulling', progress: 2, total: 8, message: 'Syncing branches...' });
      result.pulled += await this.pullTable('branches', 'updated_at');
      
      this.emitProgress({ phase: 'pulling', progress: 3, total: 8, message: 'Syncing branch assignments...' });
      result.pulled += await this.pullTable('user_branch_assignments', 'updated_at');
      
      this.emitProgress({ phase: 'pulling', progress: 4, total: 8, message: 'Syncing registers...' });
      result.pulled += await this.pullTable('pos_registers', 'updated_at');
      
      this.emitProgress({ phase: 'pulling', progress: 5, total: 8, message: 'Syncing cashiers...' });
      result.pulled += await this.pullTable('pos_cashiers', 'updated_at');
      
      this.emitProgress({ phase: 'pulling', progress: 6, total: 8, message: 'Syncing tax rates...' });
      result.pulled += await this.pullTable('tax_rates', 'updated_at');
      
      this.emitProgress({ phase: 'pulling', progress: 7, total: 8, message: 'Syncing discounts...' });
      result.pulled += await this.pullTable('pos_discounts', 'updated_at');

      // Push transactions
      this.emitProgress({ phase: 'pushing', progress: 0, total: 1, message: 'Pushing transactions...' });
      const pushResult = await this.pushPendingTransactions();
      result.pushed = pushResult.synced;
      result.failed = pushResult.failed;

      this.emitProgress({ phase: 'complete', progress: 1, total: 1, message: 'Sync complete' });

    } catch (error) {
      result.success = false;
      result.error = error instanceof Error ? error.message : 'Sync failed';
      this.emitProgress({ phase: 'error', progress: 0, total: 0, message: result.error });
    } finally {
      this.isSyncing = false;
      result.duration = Date.now() - startTime;
    }

    return result;
  }

  /**
   * Pull a table from Supabase
   */
  private async pullTable(tableName: string, timestampField: string): Promise<number> {
    if (!this.organizationId) return 0;

    try {
      // Get last sync timestamp
      const metaResult = await executeQuery<{ last_server_timestamp: string }>(
        'SELECT last_server_timestamp FROM sync_metadata WHERE table_name = ?',
        [tableName]
      );
      
      const lastSync = metaResult.data?.[0]?.last_server_timestamp || '1970-01-01T00:00:00Z';

      // Fetch from Supabase — always company-scoped. Without the business
      // filter, a cashier's offline tablet would cache every sister-company
      // product/contact/register, which is both a performance and a data-
      // isolation failure.
      if (!this.businessId) {
        console.warn(`[SQLiteSyncManager] No businessId set — skipping pull for ${tableName}`);
        return 0;
      }
      let q = (supabase as any)
        .from(tableName)
        .select('*')
        .eq('organization_id', this.organizationId)
        .eq('business_id', this.businessId)
        .gt(timestampField, lastSync)
        .order(timestampField, { ascending: true })
        .limit(1000);
      // Narrow further by branch when the table is branch-scoped and a branch
      // is active (POS cashier logged in to a specific shop).
      const BRANCH_SCOPED = new Set(['pos_registers', 'pos_cashiers']);
      if (this.branchId && BRANCH_SCOPED.has(tableName)) {
        q = q.eq('branch_id', this.branchId);
      }
      const { data, error } = await q;

      if (error) {
        console.error(`Failed to pull ${tableName}:`, error);
        return 0;
      }

      if (!data || data.length === 0) {
        return 0;
      }

      // Build upsert queries
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      
      for (const record of data) {
        const columns = Object.keys(record);
        const placeholders = columns.map(() => '?').join(', ');
        const updates = columns.filter(c => c !== 'id').map(c => `${c} = excluded.${c}`).join(', ');
        
        queries.push({
          sql: `
            INSERT INTO ${tableName} (${columns.join(', ')}, synced_at)
            VALUES (${placeholders}, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET ${updates}, synced_at = datetime('now')
          `,
          params: columns.map(c => {
            const val = record[c];
            return typeof val === 'object' ? JSON.stringify(val) : val;
          }),
        });
      }

      // Update sync metadata
      const lastRecord = data[data.length - 1];
      queries.push({
        sql: `
          INSERT INTO sync_metadata (table_name, last_synced_at, last_server_timestamp, records_synced, sync_direction)
          VALUES (?, datetime('now'), ?, ?, 'down')
          ON CONFLICT(table_name) DO UPDATE SET
            last_synced_at = datetime('now'),
            last_server_timestamp = excluded.last_server_timestamp,
            records_synced = records_synced + excluded.records_synced
        `,
        params: [tableName, lastRecord[timestampField], data.length],
      });

      await executeTransaction(queries);
      return data.length;

    } catch (error) {
      console.error(`Error pulling ${tableName}:`, error);
      return 0;
    }
  }

  /**
   * Push pending transactions to server
   */
  private async pushPendingTransactions(): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;

    try {
      // Get pending transactions
      const result = await executeQuery<{
        id: string;
        transaction_number: string;
        register_id: string;
        shift_id: string;
        customer_id: string;
        subtotal: number;
        tax_amount: number;
        discount_amount: number;
        discount_type: string;
        total: number;
        payment_status: string;
        status: string;
        notes: string;
        created_by: string;
        created_at: string;
      }>(
        `SELECT * FROM pos_transactions 
         WHERE sync_status IN ('pending', 'failed') 
         ORDER BY created_at ASC 
         LIMIT 50`
      );

      if (!result.success || !result.data?.length) {
        return { synced: 0, failed: 0 };
      }

      for (const tx of result.data) {
        try {
          // Branch isolation: every uploaded transaction MUST carry the
          // owning branch. If the queued row was captured before setScope
          // received a branch (rare; offline-first edge case), reject the
          // upload loudly instead of silently stamping NULL — a NULL-branch
          // sale escapes every branch report and the GL poster.
          if (!this.branchId) {
            await executeQuery(
              `UPDATE pos_transactions SET sync_status = 'failed', sync_error = ? WHERE id = ?`,
              [
                'Cannot upload: offline transaction has no branch context. ' +
                  'Open the POS in the owning branch to retry sync.',
                tx.id,
              ],
            );
            continue;
          }
          // Wave 2 · Phase C-3 — offline replay MUST route through
          // `process_pos_transaction`, which delegates payment writes to
          // `_pos_record_payment`. Direct inserts into
          // `pos_transaction_payments` bypass the card FSM guard, the
          // catalog validator, GL posting trigger, stock consumption, and
          // idempotency collapse — the exact same failure modes the
          // architecture guard test locks out of the server RPCs.
          const itemsResult = await executeQuery<any>(
            'SELECT * FROM pos_transaction_items WHERE transaction_id = ? ORDER BY sort_order ASC',
            [tx.id]
          );
          const paymentsResult = await executeQuery<any>(
            'SELECT * FROM pos_transaction_payments WHERE transaction_id = ?',
            [tx.id]
          );

          const items = (itemsResult.data ?? []).map((item: any) => ({
            product_id: item.product_id,
            name: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            discount_type: item.discount_type || null,
            discount_value: item.discount_value ?? 0,
            tax_rate: item.tax_rate ?? 0,
            tax_amount: item.tax_amount ?? 0,
            line_total: item.line_total,
            cost_price: item.cost_price ?? null,
            tax_rate_id: item.tax_rate_id ?? null,
            etims_tax_code: item.etims_tax_code ?? null,
            packaging_id: item.packaging_id ?? null,
            display_uom_id: item.display_uom_id ?? null,
            display_quantity: item.display_quantity ?? null,
            base_uom_id: item.base_uom_id ?? null,
          }));

          const payments = (paymentsResult.data ?? []).map((p: any) => ({
            payment_method: p.payment_method,
            amount: p.amount,
            tendered_amount: p.tendered_amount ?? p.amount,
            change_given: p.payment_method === 'cash' ? (p.change_given ?? 0) : 0,
            reference: p.reference || null,
            card_last_four: p.card_last_four ?? null,
            card_type: p.card_type ?? null,
            mpesa_receipt_number: p.mpesa_receipt ?? p.mpesa_receipt_number ?? null,
            // Card FSM initial state + vendor auth trail — preserved
            // through the offline queue so the guard trigger sees the
            // same state it would on the online path.
            auth_state: p.auth_state ?? null,
            auth_id: p.auth_id ?? null,
            vendor_txn_id: p.vendor_txn_id ?? null,
            authorized_amount: p.authorized_amount ?? null,
          }));

          const { data: rpcResult, error: rpcError } = await supabase.rpc(
            'process_pos_transaction' as any,
            {
              p_organization_id: this.organizationId,
              p_business_id: this.businessId,
              p_register_id: tx.register_id,
              p_shift_id: tx.shift_id,
              p_items: items,
              p_payments: payments,
              p_subtotal: tx.subtotal,
              p_tax_amount: tx.tax_amount,
              p_discount_amount: tx.discount_amount,
              p_total: tx.total,
              p_customer_id: tx.customer_id || null,
              p_customer_name: null,
              p_notes: `${tx.notes || ''} [Synced from offline: ${tx.transaction_number}]`.trim(),
              p_created_by: tx.created_by,
              p_transaction_type: 'sale',
              p_table_session_id: null,
              p_tip_amount: 0,
              p_original_transaction_id: null,
              // The local row id is stable across retries — reuse it as
              // the idempotency key so the RPC collapses replay attempts.
              p_idempotency_key: tx.id,
            }
          );

          if (rpcError) throw rpcError;
          const rr = rpcResult as any;
          if (!rr?.success) {
            throw new Error(rr?.error || 'Transaction processing failed');
          }

          // Mark as synced locally
          await executeQuery(
            `UPDATE pos_transactions 
             SET sync_status = 'synced', server_id = ?, synced_at = datetime('now'), sync_error = NULL 
             WHERE id = ?`,
            [rr.transaction_id, tx.id]
          );

          synced++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          await executeQuery(
            `UPDATE pos_transactions SET sync_status = 'failed', sync_error = ? WHERE id = ?`,
            [errorMsg, tx.id]
          );
          failed++;
        }
      }
    } catch (error) {
      console.error('Push transactions error:', error);
    }

    return { synced, failed };
  }

  /**
   * Start automatic sync interval
   */
  startAutoSync(intervalMinutes: number = 5): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    this.syncInterval = setInterval(async () => {
      if (navigator.onLine && !this.isSyncing) {
        const pendingCount = await getPendingSyncCount();
        if (pendingCount > 0) {
          console.log(`Auto-sync: ${pendingCount} pending records`);
          const result = await this.fullSync();
          if (result.pushed > 0) {
            toast.success(`Synced ${result.pushed} transactions`);
          }
        }
      }
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Stop automatic sync
   */
  stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  /**
   * Check if sync is in progress
   */
  getIsSyncing(): boolean {
    return this.isSyncing;
  }

  /**
   * Get pending sync count
   */
  async getPendingCount(): Promise<number> {
    return getPendingSyncCount();
  }
}

// Singleton instance
export const sqliteSyncManager = new SQLiteSyncManager();
