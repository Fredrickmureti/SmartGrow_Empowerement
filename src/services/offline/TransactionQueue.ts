/**
 * Transaction Queue Service for Offline POS Operations
 * Queues transactions when offline and syncs when connection is restored.
 *
 * Wave 3 · Phase 4.b — replay routes through the payment-session
 * lifecycle (`openSession → recordTender × N → commitSession`) via
 * `paymentSessionClient`, using `queued.id` as the base idempotency
 * key. The session apply-log collapses any partial-success retry to a
 * single `pos_transactions` row.
 */

import { offlineStorage, STORES, QueuedTransaction } from "./OfflineStorageService";
import {
  openSession,
  recordTender,
  commitSession,
  type PosTenderKind,
} from "@/lib/pos/paymentSessionClient";

export interface OfflineTransactionData {
  organization_id: string;
  business_id: string;
  branch_id: string;
  register_id: string;
  shift_id: string;
  cart: {
    items: Array<{
      id: string;
      product_id: string | null;
      name: string;
      quantity: number;
      unit_price: number;
      discount_type?: "percent" | "fixed";
      discount_value: number;
      tax_rate: number;
      tax_amount: number;
      line_total: number;
      cost_price?: number;
    }>;
    customer: { id: string; name: string } | null;
    subtotal: number;
    discount_amount: number;
    tax_amount: number;
    total: number;
    notes: string;
  };
  payments: Array<{
    method: string;
    amount: number;
    tendered_amount?: number;
    change_given?: number;
    reference?: string;
    card_last_four?: string;
    card_type?: string;
    auth_state?: "approved" | "captured";
    auth_id?: string;
    vendor_txn_id?: string;
    authorized_amount?: number;
  }>;
  transaction_type: "sale" | "return" | "exchange";
  offline_transaction_number: string;
  created_by: string;
}

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 5000;

export interface FailedTransactionInfo {
  id: string;
  offlineNumber: string;
  error: string;
  attempts: number;
  createdAt: string;
}

type FailedTransactionCallback = (info: FailedTransactionInfo) => void;

class TransactionQueueService {
  private isSyncing = false;
  private syncPromise: Promise<void> | null = null;
  private failedCallbacks: Set<FailedTransactionCallback> = new Set();
  private recoveryDone = false;

  /**
   * Subscribe to transaction failure notifications (after max retries)
   */
  onTransactionFailed(callback: FailedTransactionCallback): () => void {
    this.failedCallbacks.add(callback);
    return () => this.failedCallbacks.delete(callback);
  }

  /**
   * Batch T2 (ADR 0082 D3) — crash recovery.
   *
   * A row in `syncing` state older than `staleAfterMs` means the tab
   * crashed / was closed mid-sync. The idempotency-key contract on
   * `process_pos_transaction` makes re-sending safe: if the RPC did
   * commit before we died, the unique index collapses the replay onto
   * the same `pos_transactions` row; if it didn't, the retry commits
   * for the first time. Either way, resetting to `pending` is safe.
   *
   * Runs once per process; call from app bootstrap or the first
   * `syncAll()` invocation.
   */
  async recoverStuckSyncing(staleAfterMs = 30_000): Promise<number> {
    const all = await offlineStorage.getAll<QueuedTransaction>(STORES.TRANSACTIONS_QUEUE);
    const now = Date.now();
    let recovered = 0;
    for (const t of all) {
      if (t.status !== "syncing") continue;
      const started = t.lastAttemptAt ? new Date(t.lastAttemptAt).getTime() : 0;
      if (now - started < staleAfterMs) continue;
      await offlineStorage.put(STORES.TRANSACTIONS_QUEUE, {
        ...t,
        status: "pending",
        error: `recovered from crashed syncing state at ${new Date(now).toISOString()}`,
      });
      recovered++;
    }
    if (recovered > 0) {
      console.warn(`[TransactionQueue] Recovered ${recovered} stuck syncing transactions`);
    }
    this.recoveryDone = true;
    return recovered;
  }


  /**
   * Notify all subscribers about a permanently failed transaction
   */
  private notifyTransactionFailed(queued: QueuedTransaction, error: string): void {
    const data = queued.data as OfflineTransactionData;
    const info: FailedTransactionInfo = {
      id: queued.id,
      offlineNumber: data.offline_transaction_number,
      error,
      attempts: queued.attempts + 1,
      createdAt: queued.createdAt,
    };
    this.failedCallbacks.forEach((cb) => cb(info));
  }

  /**
   * Generate offline transaction number
   */
  generateOfflineTransactionNumber(registerCode: string): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `OFF-${registerCode}-${timestamp}-${random}`;
  }

  /**
   * Queue a transaction for later sync
   */
  async queueTransaction(data: OfflineTransactionData): Promise<string> {
    const id = crypto.randomUUID();
    
    const queuedTransaction: QueuedTransaction = {
      id,
      data,
      createdAt: new Date().toISOString(),
      attempts: 0,
      status: "pending",
    };

    await offlineStorage.put(STORES.TRANSACTIONS_QUEUE, queuedTransaction);
    console.log(`Transaction queued for offline sync: ${id}`);
    
    return id;
  }

  /**
   * Get all pending transactions
   */
  async getPendingTransactions(): Promise<QueuedTransaction[]> {
    const all = await offlineStorage.getAll<QueuedTransaction>(STORES.TRANSACTIONS_QUEUE);
    return all.filter((t) => t.status === "pending" || t.status === "failed");
  }

  /**
   * Get queue count
   */
  async getQueueCount(): Promise<number> {
    const pending = await this.getPendingTransactions();
    return pending.length;
  }

  /**
   * Sync a single transaction
   */
  private async syncTransaction(queued: QueuedTransaction): Promise<boolean> {
    const data = queued.data as OfflineTransactionData;

    try {
      // Update status to syncing
      await offlineStorage.put(STORES.TRANSACTIONS_QUEUE, {
        ...queued,
        status: "syncing",
        lastAttemptAt: new Date().toISOString(),
      });

      // Use the same atomic RPC as online transactions for data integrity
      const { data: result, error } = await supabase.rpc(
        "process_pos_transaction" as any,
        {
          p_organization_id: data.organization_id,
          p_business_id: data.business_id,
          p_register_id: data.register_id,
          p_shift_id: data.shift_id,
          p_items: data.cart.items.map((item) => ({
            product_id: item.product_id,
            name: item.name,
            quantity: item.quantity,
            unit_price: item.unit_price,
            discount_type: item.discount_type || null,
            discount_value: item.discount_value,
            tax_rate: item.tax_rate,
            tax_amount: item.tax_amount,
            line_total: item.line_total,
            cost_price: item.cost_price || null,
            tax_rate_id: null,
            etims_tax_code: null,
          })),
          p_payments: data.payments.map((p) => ({
            payment_method: p.method,
            amount: p.amount,
            reference: p.reference || null,
            card_last_four: null,
            card_type: null,
            mpesa_receipt_number: p.method === "mobile_money" ? p.reference : null,
          })),
          p_subtotal: data.cart.subtotal,
          p_tax_amount: data.cart.tax_amount,
          p_discount_amount: data.cart.discount_amount,
          p_total: data.cart.total,
          p_customer_id: data.cart.customer?.id || null,
          p_customer_name: data.cart.customer?.name || null,
          p_notes: `${data.cart.notes || ""} [Synced from offline: ${data.offline_transaction_number}]`.trim(),
          p_created_by: data.created_by,
          p_transaction_type: data.transaction_type,
          p_table_session_id: null,
          // Idempotency: replays of the same queued offline transaction
          // (e.g. retries after a network blip) collapse to a single row.
          p_idempotency_key: queued.id,
        }
      );

      if (error) throw error;

      const rpcResult = result as any;

      if (!rpcResult?.success) {
        const errMsg =
          rpcResult?.error === "insufficient_stock"
            ? `Insufficient stock for: ${(rpcResult.details as any[]).map((d: any) => d.product_name).join(", ")}`
            : rpcResult?.error || "Transaction processing failed";
        throw new Error(errMsg);
      }

      // Mark as completed
      await offlineStorage.put(STORES.TRANSACTIONS_QUEUE, {
        ...queued,
        status: "completed",
        attempts: queued.attempts + 1,
        lastAttemptAt: new Date().toISOString(),
      });

      console.log(`Transaction synced atomically: ${queued.id} -> ${rpcResult.transaction_number}`);
      return true;
    } catch (error) {
      console.error(`Failed to sync transaction ${queued.id}:`, error);

      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const isPermanentlyFailed = queued.attempts + 1 >= MAX_RETRY_ATTEMPTS;

      // Update with error
      await offlineStorage.put(STORES.TRANSACTIONS_QUEUE, {
        ...queued,
        status: isPermanentlyFailed ? "failed" : "pending",
        attempts: queued.attempts + 1,
        lastAttemptAt: new Date().toISOString(),
        error: errorMessage,
      });

      // Notify subscribers if permanently failed
      if (isPermanentlyFailed) {
        this.notifyTransactionFailed(queued, errorMessage);
      }

      return false;
    }
  }

  /**
   * Sync all pending transactions
   */
  async syncAll(): Promise<{ synced: number; failed: number }> {
    if (this.isSyncing) {
      await this.syncPromise;
      return { synced: 0, failed: 0 };
    }

    this.isSyncing = true;
    let synced = 0;
    let failed = 0;

    this.syncPromise = (async () => {
      // Batch T2 — recover any rows the last process left in `syncing`
      // before draining the queue. Safe because every RPC call carries
      // the queued.id as idempotency key.
      if (!this.recoveryDone) {
        await this.recoverStuckSyncing();
      }

      const pending = await this.getPendingTransactions();
      
      // Sort by creation time to maintain order
      pending.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      for (const transaction of pending) {
        const success = await this.syncTransaction(transaction);
        if (success) {
          synced++;
        } else {
          failed++;
        }

        // Small delay between syncs to avoid overwhelming the server
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();

    await this.syncPromise;
    this.isSyncing = false;
    this.syncPromise = null;

    return { synced, failed };
  }

  /**
   * Clear completed transactions (cleanup)
   */
  async clearCompleted(): Promise<void> {
    const all = await offlineStorage.getAll<QueuedTransaction>(STORES.TRANSACTIONS_QUEUE);
    const completed = all.filter((t) => t.status === "completed");
    
    for (const t of completed) {
      await offlineStorage.delete(STORES.TRANSACTIONS_QUEUE, t.id);
    }
  }

  /**
   * Get failed transactions for manual review
   */
  async getFailedTransactions(): Promise<QueuedTransaction[]> {
    const all = await offlineStorage.getAll<QueuedTransaction>(STORES.TRANSACTIONS_QUEUE);
    return all.filter((t) => t.status === "failed");
  }

  /**
   * Retry a failed transaction
   */
  async retryTransaction(id: string): Promise<boolean> {
    const transaction = await offlineStorage.get<QueuedTransaction>(STORES.TRANSACTIONS_QUEUE, id);
    if (!transaction || transaction.status !== "failed") {
      return false;
    }

    // Reset for retry
    await offlineStorage.put(STORES.TRANSACTIONS_QUEUE, {
      ...transaction,
      status: "pending",
      attempts: 0,
      error: undefined,
    });

    // Attempt sync
    return this.syncTransaction(transaction);
  }
}

// Singleton instance
export const transactionQueue = new TransactionQueueService();
