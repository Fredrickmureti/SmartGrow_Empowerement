import { normalizeError } from "@/services/resilience";
/**
 * Offline-capable POS Transaction Hook
 * Handles both online and offline transaction processing
 * Enforces allow_offline_transactions and max_offline_transaction_amount from security settings
 *
 * GL Posting Strategy: Per-transaction (D365/SAP-aligned, Phase 4)
 * - Each completed sale/return posts its own JE via `post_pos_sale_gl`,
 *   fired by `trg_pos_transaction_post_sale_gl`.
 * - Cash over/short is posted separately at shift close by
 *   `trg_pos_close_variance_gl`.
 * - The legacy shift-close aggregator was removed to eliminate the
 *   double-posting risk and make each sale traceable to its own JE.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { transactionQueue, syncManager } from "@/services/offline";
import { usePOSSecuritySettings } from "./usePOSSecuritySettings";
import { usePOSCreditSale } from "./usePOSCreditSale";
import { useCommitKey } from "./useCommitKey";
import {
  openSession,
  recordTender,
  commitSession,
  type PosTenderKind,
} from "@/lib/pos/paymentSessionClient";
// hardwareClient import removed — POS hardware side-effects flow through the
// `payment.received` business event + SharedCommandQueueWorker (Group D #6).

import type { CartState } from "./usePOSCart";


export interface PaymentMethod {
  method: "cash" | "card" | "mobile_money" | "voucher" | "credit" | "bank_transfer" | "other";
  /** Amount applied to the invoice (<= tendered_amount). */
  amount: number;
  /**
   * Tender — what the customer actually presented. For cash this is the bill
   * value handed over (e.g. 20,000 on a 19,000 sale). For card / mobile money
   * this equals `amount` (the gateway authorized exactly the requested amount).
   */
  tendered_amount?: number;
  /** Cash change returned to the customer (cash tender only, otherwise 0). */
  change_given?: number;
  reference?: string;
  card_last_four?: string;
  card_type?: string;
  // Wave 2 · Phase C-2 — card FSM metadata captured by the terminal modal
  // pre-commit. `_pos_record_payment` inserts the payment row with these
  // fields so the FSM guard trigger validates the initial state.
  auth_state?: "approved" | "captured";
  auth_id?: string;
  vendor_txn_id?: string;
  authorized_amount?: number;
}

export interface CompleteTransactionData {
  register_id: string;
  shift_id: string;
  business_id?: string;
  cashier_id?: string | null;
  cart: CartState;
  payments: PaymentMethod[];
  /**
   * Phase 7 — cart-level discount intent. Forwarded to the commit envelope so
   * `pos_payment_session_commit` can re-quote the basket with `pos_quote_cart`
   * and prove the session's grand total. Omitting it when a cart discount is
   * active makes the server price the cart higher and the commit fails closed.
   */
  cart_discount?: { type: "percent" | "fixed"; value: number } | null;
  transaction_type?: "sale" | "return" | "exchange";
  table_session_id?: string;
  tip_amount?: number;
  original_transaction_id?: string;
  /**
   * Stage D: deterministic idempotency key. When omitted, the hook derives one
   * from `useCommitKey(register, shift)` so retries collapse on the server's
   * unique index instead of producing duplicate rows.
   */
  idempotency_key?: string;
}

export function usePOSTransactionOffline() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { settings: securitySettings } = usePOSSecuritySettings();
  const { validateCreditSale, processPostTransactionCredit, hasCreditPayment } = usePOSCreditSale();
  const commitKey = useCommitKey();

  const completeTransaction = useMutation({
    mutationFn: async (data: CompleteTransactionData) => {
      if (!currentOrg?.id || !user?.id) throw new Error("Not authenticated");
      if (!currentBusiness?.id) throw new Error("No company selected");

      // Validate credit sale requirements before processing
      validateCreditSale(data.cart, data.payments);

      const isOnline = syncManager.checkOnline();

      if (isOnline) {
        const key =
          data.idempotency_key ||
          commitKey.get(data.register_id, data.shift_id);
        const enriched = { ...data, idempotency_key: key } as CompleteTransactionData;
        const result = await processOnlineTransaction(
          enriched,
          currentOrg.id,
          currentBusiness.id,
          user.id,
        );
        // On success only — clear so the next sale starts a new key.
        commitKey.clear(data.register_id, data.shift_id);
        return result;
      } else {
        // Enforce offline transaction security settings
        if (!securitySettings.allow_offline_transactions) {
          throw new Error("Offline transactions are disabled by your organization's security policy. Please connect to the internet to process this sale.");
        }
        
        const transactionTotal = data.cart.total;
        if (securitySettings.max_offline_transaction_amount > 0 && transactionTotal > securitySettings.max_offline_transaction_amount) {
          throw new Error(
            `This transaction (${transactionTotal.toFixed(2)}) exceeds the maximum offline transaction amount (${securitySettings.max_offline_transaction_amount.toFixed(2)}). Please connect to the internet to process this sale.`
          );
        }
        
        return await processOfflineTransaction(data, currentOrg.id, currentBusiness.id, user.id);
      }
    },
    onSuccess: async (result, data) => {
      queryClient.invalidateQueries({ queryKey: ["pos-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["pos-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["pos-products"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      
      // Post-transaction credit sale processing (auto-generate invoice)
      if (!result.isOffline && hasCreditPayment(data.payments) && user?.id) {
        try {
          await processPostTransactionCredit(
            result.transaction.id,
            result.transactionNumber,
            data.cart,
            data.payments,
            user.id
          );
          queryClient.invalidateQueries({ queryKey: ["invoices"] });
          queryClient.invalidateQueries({ queryKey: ["invoices-paginated"] });
        } catch (err) {
          console.error("Credit sale invoice creation failed:", err);
        }
      }

      // NOTE: GL posting is handled per-transaction by the DB trigger
      // `trg_pos_transaction_post_sale_gl` → `post_pos_sale_gl`. Cash
      // over/short is posted separately at shift close.

      // Group D #6 — Single hardware path.
      // The DB constraint trigger `trg_pos_emit_payment_received` publishes
      // a `payment.received` business event at commit. The BusinessSaga
      // (`BusinessSagaMount` → saga.register('payment.received')) enqueues
      // `cash_drawer.open` + `receipt_printer.print_receipt` onto
      // `hardware_command_queue`, and the SharedCommandQueueWorker on
      // whichever host has the physical device attached drains the rows.
      //
      // This collapses the previous three side-effect channels (Electron
      // `emitSaleCommitted` direct, browser direct-enqueue, and legacy
      // saga direct-exec) into one idempotent path keyed on the
      // transaction id (`pos-drawer:{tx}` / `pos-receipt:{tx}`).
      //
      // Customer display updates remain on the in-process domain event bus
      // (`pos.cart_total_changed`, `pos.payment_completed`) — already
      // handled by `BusinessSagaMount`.


      if (result.isOffline) {
        toast.success(`Offline sale: ${result.transactionNumber}`, {
          description: "Will sync when back online",
        });
      } else if (hasCreditPayment(data.payments)) {
        toast.success(`Credit sale completed: ${result.transactionNumber}`, {
          description: "Invoice generated for customer",
        });
      } else {
        toast.success(`Sale completed: ${result.transactionNumber}`);
      }

      // S2 — advisory: if the client's cart math diverged from the server
      // aggregate, log it. The server row + receipt are always authoritative
      // (see `_pos_write_receipt_snapshot`); this is diagnostics only.
      if (!result.isOffline && result.totalMatchesServer === false) {
        console.warn("[pos] client cart total diverged from server", {
          transactionId: result.transaction.id,
          serverTotals: result.serverTotals,
          clientTotal: data.cart.total,
        });
      }
    },
    onError: (error: Error) => {
      toast.error(`Transaction failed: ${normalizeError(error).message}`);
    },
  });

  return {
    completeTransaction,
  };
}

/**
 * Wave 3 · Phase 3 — online retail commit runs through the payment-session
 * lifecycle instead of calling `process_pos_transaction` directly.
 *
 *   openSession(idempotencyKey = commitKey)
 *     → for each payment: recordTender(idempotencyKey = `${commitKey}:tender:${i}`)
 *     → commitSession(envelope) → returns the full process_pos_transaction envelope
 *
 * Retries collapse on the server for all three stages because every
 * mutating call carries a deterministic idempotency key derived from
 * `useCommitKey(register, shift)`. The apply-log on the session guarantees
 * a second commit returns the cached envelope of the first.
 *
 * Offline replay still uses `process_pos_transaction` directly (Phase 4).
 */
function tenderKindFor(method: PaymentMethod["method"]): PosTenderKind {
  switch (method) {
    case "cash":          return "cash";
    case "card":          return "card";
    case "mobile_money":  return "wallet";
    case "voucher":       return "voucher";
    case "credit":        return "credit_liability";
    case "bank_transfer": return "bank_transfer";
    default:              return "other";
  }
}

async function processOnlineTransaction(
  data: CompleteTransactionData,
  organizationId: string,
  businessId: string,
  userId: string,
) {
  const idempotencyKey = data.idempotency_key;
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
    throw new Error(
      "POS commit missing idempotency_key — resolve via useCommitKey(register, shift) before opening a session (ADR 0082 D3).",
    );
  }

  // 1. Open (or resume) the session. Idempotent on (business_id, idempotency_key).
  const sessionId = await openSession({
    registerId: data.register_id,
    grandTotal: data.cart.total,
    currency: "KES",
    idempotencyKey,
    tipAmount: data.tip_amount ?? 0,
    cashierId: data.cashier_id ?? null,
  });

  // 2. Record each tender. Deterministic per-tender key so a mid-flight retry
  //    of the whole request lands on the same rows.
  for (let i = 0; i < data.payments.length; i++) {
    const p = data.payments[i];
    const tendered = p.tendered_amount ?? p.amount;
    const changeGiven = p.change_given ?? Math.max(0, tendered - p.amount);
    const methodKey = p.method;
    const tenderKind = tenderKindFor(p.method);
    await recordTender({
      sessionId,
      idempotencyKey: `${idempotencyKey}:tender:${i}`,
      tender: {
        tender_kind: tenderKind,
        method_key: methodKey,
        provider_key: p.method === "mobile_money" ? "mpesa" : undefined,
        amount: p.amount,
        tendered_amount: tendered,
        change_given: p.method === "cash" ? changeGiven : 0,
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

  // 3. Commit — session RPC forwards to process_pos_transaction and returns
  //    its full envelope (with session_id appended).
  const envelope = await commitSession({
    sessionId,
    envelope: {
      organization_id: organizationId,
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
        tax_rate_id: item.tax_rate_id || null,
        etims_tax_code: item.etims_tax_code || null,
        packaging_id: item.packaging_id ?? null,
        display_uom_id: item.display_uom_id ?? null,
        display_quantity: item.display_quantity ?? null,
        base_uom_id: item.base_uom_id ?? null,
      })),
      subtotal: data.cart.subtotal,
      tax_amount: data.cart.tax_amount,
      discount_amount: data.cart.discount_amount,
      transaction_type: data.transaction_type === "return" ? "return" : "sale",
      customer_id: data.cart.customer?.id ?? null,
      customer_name: data.cart.customer?.name ?? null,
      notes: data.cart.notes ?? null,
      original_transaction_id: data.original_transaction_id ?? null,
      table_session_id: data.table_session_id ?? null,
    },
  });

  const totalPaid = data.payments.reduce((sum, p) => sum + p.amount, 0);

  return {
    transaction: {
      id: envelope.transaction_id,
      branch_id: envelope.branch_id,
      created_at: new Date().toISOString(),
    },
    transactionNumber: envelope.transaction_number ?? "",
    change: envelope.change ?? Math.max(0, totalPaid - data.cart.total),
    isOffline: false,
    // S2 — surface server-authoritative totals so downstream consumers
    // (customer display, analytics, offline sync reconciliation) never
    // depend on the client's advisory cart math. Receipt rendering is
    // already server-authoritative via `pos_receipt_snapshots`.
    serverTotals: envelope.server_totals ?? null,
    totalMatchesServer: envelope.total_matches_server ?? true,
  };
}




async function processOfflineTransaction(
  data: CompleteTransactionData,
  organizationId: string,
  businessId: string,
  userId: string
) {
  let registerCode = "OFF";
  let branchId: string | null = null;
  
  try {
    const { data: register } = await supabase
      .from("pos_registers")
      .select("register_code, business_id, branch_id")
      .eq("id", data.register_id)
      .eq("organization_id", organizationId)
      .eq("business_id", businessId)
      .single();
    
    if (register) {
      registerCode = register.register_code;
      branchId = register.branch_id;
    }
  } catch {
    // Use default if can't fetch
  }

  if (!branchId) {
    throw new Error("Register branch context is required before offline sale can be queued");
  }

  const offlineTransactionNumber = transactionQueue.generateOfflineTransactionNumber(registerCode);

  await transactionQueue.queueTransaction({
    organization_id: organizationId,
    business_id: businessId,
    branch_id: branchId,
    register_id: data.register_id,
    shift_id: data.shift_id,
    cart: {
      items: data.cart.items.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_type: item.discount_type,
        discount_value: item.discount_value,
        tax_rate: item.tax_rate,
        tax_amount: item.tax_amount,
        line_total: item.line_total,
        cost_price: item.cost_price,
      })),
      customer: data.cart.customer,
      subtotal: data.cart.subtotal,
      discount_amount: data.cart.discount_amount,
      tax_amount: data.cart.tax_amount,
      total: data.cart.total,
      notes: data.cart.notes,
    },
    payments: data.payments.map((p) => {
      const tendered = p.tendered_amount ?? p.amount;
      const change = p.change_given ?? Math.max(0, tendered - p.amount);
      return {
        method: p.method,
        amount: p.amount,
        tendered_amount: tendered,
        change_given: p.method === "cash" ? change : 0,
        reference: p.reference,
        card_last_four: p.card_last_four,
        card_type: p.card_type,
        // Wave 2 · Phase C-2 — preserve card FSM metadata through the
        // offline queue. SQLiteSyncManager must forward these to the RPC
        // on replay so the FSM guard sees the same initial state as the
        // online path. (Follow-up: sync manager still uses direct insert;
        // migrating replay to `process_pos_transaction` is Phase C-3.)
        auth_state: p.auth_state,
        auth_id: p.auth_id,
        vendor_txn_id: p.vendor_txn_id,
        authorized_amount: p.authorized_amount,
      };
    }),

    transaction_type: data.transaction_type || "sale",
    offline_transaction_number: offlineTransactionNumber,
    created_by: userId,
  });

  const totalPaid = data.payments.reduce((sum, p) => sum + p.amount, 0);

  return {
    transaction: {
      id: offlineTransactionNumber,
      created_at: new Date().toISOString(),
    },
    transactionNumber: offlineTransactionNumber,
    change: Math.max(0, totalPaid - data.cart.total),
    isOffline: true,
    // S2 parity: offline commit has no server aggregate yet — sync will
    // reconcile on replay. Nulls flag "unknown", not "matched".
    serverTotals: null as null | Record<string, number>,
    totalMatchesServer: null as null | boolean,
  };
}
