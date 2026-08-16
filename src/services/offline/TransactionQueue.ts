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
/** Base unit of the exponential backoff schedule (attempt 1 waits this long). */
const RETRY_DELAY_MS = 5000;
/** Cap so a long-offline queue still drains promptly once connectivity returns. */
const MAX_RETRY_DELAY_MS = 5 * 60_000;
/** Politeness gap between two rows in the same drain. */
const INTER_SYNC_GAP_MS = 100;

/**
 * Phase 9 — exponential backoff with jitter.
 *
 * attempt 1 → ~5s, 2 → ~10s, 3 → ~20s, 4 → ~40s, capped at 5 min.
 * Jitter (±20%) prevents a whole store's terminals from re-drumming the
 * server in lockstep after a shared outage.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Phase 9 — error classification.
 *
 * A *permanent* error is one the server will reject identically on every
 * replay: a closed till (`shift_closed`), a violated business invariant
 * (check/unique constraint), an access denial, or a malformed envelope.
 * Retrying those only delays the operator seeing the truth and burns the
 * retry budget. Everything else (network, timeout, 5xx, unknown) is treated
 * as transient — the safest default, because replay is idempotent: the
 * session apply-log collapses a duplicate commit onto the same transaction.
 */
const PERMANENT_ERROR_PATTERNS: RegExp[] = [
  /shift_closed/i,
  /till_closed/i,
  /check_violation/i,
  /violates check constraint/i,
  /foreign key constraint/i,
  /not-null constraint/i,
  /invalid input syntax/i,
  /permission denied/i,
  /access denied/i,
  /override_required/i,
  /session_not_open/i,
  /total mismatch/i,
];

const PERMANENT_SQLSTATES = new Set(["23514", "23502", "23503", "22P02", "42501", "42883"]);

export function isPermanentError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (typeof code === "string" && PERMANENT_SQLSTATES.has(code)) return true;
  const message = [
    error instanceof Error ? error.message : String(error ?? ""),
    (error as { details?: string } | null)?.details ?? "",
    (error as { hint?: string } | null)?.hint ?? "",
  ].join(" ");
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(message));
}

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
   * Get all pending transactions.
   *
   * `failed` rows are terminal: a permanent server rejection (or an exhausted
   * retry budget) must be resolved by an operator through `retryTransaction`,
   * not silently re-driven by the next drain.
   */
  async getPendingTransactions(): Promise<QueuedTransaction[]> {
    const all = await offlineStorage.getAll<QueuedTransaction>(STORES.TRANSACTIONS_QUEUE);
    return all.filter((t) => t.status === "pending");
  }

  /** Rows eligible right now — respects the exponential backoff schedule. */
  async getDueTransactions(now = Date.now()): Promise<QueuedTransaction[]> {
    const pending = await this.getPendingTransactions();
    return pending.filter(
      (t) => !t.nextAttemptAt || new Date(t.nextAttemptAt).getTime() <= now,
    );
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

      // Wave 3 · Phase 4.b — replay routes through the payment-session
      // lifecycle. `queued.id` is the base idempotency key so a partial
      // replay collapses on the server: openSession dedupes on the same
      // key, recordTender dedupes on `${queued.id}:tender:${i}`, and
      // commitSession returns the cached envelope via the apply-log guard.
      const tenderKindFor = (m: string): PosTenderKind => {
        switch (m) {
          case "cash":          return "cash";
          case "card":          return "card";
          case "mobile_money":
          case "mpesa":         return "wallet";
          case "voucher":       return "voucher";
          case "credit":        return "credit_liability";
          case "bank_transfer": return "bank_transfer";
          default:              return "other";
        }
      };

      const sessionId = await openSession({
        registerId: data.register_id,
        grandTotal: data.cart.total,
        currency: "KES",
        idempotencyKey: queued.id,
        cashierId: data.created_by,
      });

      for (let i = 0; i < data.payments.length; i++) {
        const p = data.payments[i];
        const method = p.method === "mpesa" ? "mobile_money" : p.method;
        const tendered = p.tendered_amount ?? p.amount;
        const changeGiven = p.change_given ?? Math.max(0, tendered - p.amount);
        await recordTender({
          sessionId,
          idempotencyKey: `${queued.id}:tender:${i}`,
          tender: {
            tender_kind: tenderKindFor(method),
            method_key: method,
            provider_key: method === "mobile_money" ? "mpesa" : undefined,
            amount: p.amount,
            tendered_amount: tendered,
            change_given: method === "cash" ? changeGiven : 0,
            reference: p.reference ?? null,
            auth_state: p.auth_state ?? undefined,
            auth_id: p.auth_id ?? null,
            vendor_txn_id: p.vendor_txn_id ?? null,
            driver_payload: {
              card_last_four: p.card_last_four ?? null,
              card_type: p.card_type ?? null,
              authorized_amount: p.authorized_amount ?? null,
            },
          },
        });
      }

      const commitResult = await commitSession({
        sessionId,
        envelope: {
          organization_id: data.organization_id,
          shift_id: data.shift_id,
          items: data.cart.items.map((item) => ({
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
          subtotal: data.cart.subtotal,
          tax_amount: data.cart.tax_amount,
          discount_amount: data.cart.discount_amount,
          transaction_type: data.transaction_type === "return" ? "return" : "sale",
          customer_id: data.cart.customer?.id ?? null,
          customer_name: data.cart.customer?.name ?? null,
          notes: `${data.cart.notes || ""} [Synced from offline: ${data.offline_transaction_number}]`.trim(),
        },
      });

      // Mark as completed
      await offlineStorage.put(STORES.TRANSACTIONS_QUEUE, {
        ...queued,
        status: "completed",
        attempts: queued.attempts + 1,
        lastAttemptAt: new Date().toISOString(),
      });

      console.log(
        `Transaction synced via payment session: ${queued.id} -> ${commitResult.transaction_number ?? commitResult.transaction_id}`,
      );
      return true;
    } catch (error) {
      console.error(`Failed to sync transaction ${queued.id}:`, error);

      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      // Phase 9 — a permanent rejection must not burn MAX_RETRY_ATTEMPTS
      // against the server: the outcome cannot change by retrying.
      const permanent = isPermanentError(error);
      const attempts = queued.attempts + 1;
      const isPermanentlyFailed = permanent || attempts >= MAX_RETRY_ATTEMPTS;

      // Update with error + backoff schedule
      await offlineStorage.put(STORES.TRANSACTIONS_QUEUE, {
        ...queued,
        status: isPermanentlyFailed ? "failed" : "pending",
        attempts,
        lastAttemptAt: new Date().toISOString(),
        nextAttemptAt: isPermanentlyFailed
          ? undefined
          : new Date(Date.now() + backoffDelayMs(attempts)).toISOString(),
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

      // Only rows whose backoff window has elapsed.
      const pending = await this.getDueTransactions();

      // Sort by creation time to maintain order
      pending.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      for (const transaction of pending) {
        const success = await this.syncTransaction(transaction);
        if (success) {
          synced++;
        } else {
          failed++;
        }

        // Small delay between syncs to avoid overwhelming the server.
        // Per-row retry pacing is handled by `nextAttemptAt` (exponential
        // backoff), not by this inter-row gap.
        await new Promise((resolve) => setTimeout(resolve, INTER_SYNC_GAP_MS));
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
      nextAttemptAt: undefined,
      error: undefined,
    });

    // Attempt sync
    return this.syncTransaction(transaction);
  }
}

// Singleton instance
export const transactionQueue = new TransactionQueueService();
