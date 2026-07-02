import { normalizeError } from "@/services/resilience";
/**
 * Offline-capable POS Transaction Hook
 * Handles both online and offline transaction processing
 * Enforces allow_offline_transactions and max_offline_transaction_amount from security settings
 *
 * GL Posting Strategy: Session-based (Odoo-aligned)
 * - Transactions are posted to GL in aggregate when the shift is closed.
 * - The DB trigger `trg_pos_shift_close_journal` calls `post_pos_shift_gl`
 *   (single canonical posting path).
 * - Real-time per-transaction GL posting has been removed for scalability.
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
}

export interface CompleteTransactionData {
  register_id: string;
  shift_id: string;
  business_id?: string;
  cart: CartState;
  payments: PaymentMethod[];
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

      // NOTE: GL posting is handled at shift close by the DB trigger
      // `trg_pos_shift_close_journal` → `post_pos_shift_gl`. This is the
      // session-based aggregation pattern (Odoo-aligned) for scalability.
      // Individual transactions are NOT posted to GL in real-time.

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
    },
    onError: (error: Error) => {
      toast.error(`Transaction failed: ${normalizeError(error).message}`);
    },
  });

  return {
    completeTransaction,
  };
}

async function processOnlineTransaction(
  data: CompleteTransactionData,
  organizationId: string,
  businessId: string,
  userId: string
) {
  const { data: result, error } = await supabase.rpc(
    "process_pos_transaction" as any,
    {
      p_organization_id: organizationId,
      p_business_id: data.business_id || businessId,
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
        tax_rate_id: item.tax_rate_id || null,
        etims_tax_code: item.etims_tax_code || null,
        // Phase B UoM unification — provenance for the line. The RPC
        // normalizes via packaging triggers; `quantity` stays in base units.
        packaging_id: item.packaging_id ?? null,
        display_uom_id: item.display_uom_id ?? null,
        display_quantity: item.display_quantity ?? null,
        base_uom_id: item.base_uom_id ?? null,
      })),
      p_payments: data.payments.map((p) => {
        const tendered = p.tendered_amount ?? p.amount;
        const change = p.change_given ?? Math.max(0, tendered - p.amount);
        return {
          payment_method: p.method,
          amount: p.amount,
          tendered_amount: tendered,
          change_given: p.method === "cash" ? change : 0,
          reference: p.reference || null,
          card_last_four: p.card_last_four || null,
          card_type: p.card_type || null,
          mpesa_receipt_number: p.method === "mobile_money" ? p.reference : null,
        };
      }),
      p_subtotal: data.cart.subtotal,
      p_tax_amount: data.cart.tax_amount,
      p_discount_amount: data.cart.discount_amount,
      p_total: data.cart.total,
      p_customer_id: data.cart.customer?.id || null,
      p_customer_name: data.cart.customer?.name || null,
      p_notes: data.cart.notes || null,
      p_created_by: userId,
      p_transaction_type: data.transaction_type || "sale",
      p_table_session_id: data.table_session_id || null,
      p_tip_amount: data.tip_amount || 0,
      p_original_transaction_id: data.original_transaction_id || null,
      // Stage D idempotency: deterministic key per (register, shift, sale)
      // generated by useCommitKey and reused across retries until success.
      // Falls back to a random UUID only if no caller key was supplied — that
      // path still de-duplicates the immediate response but cannot collapse a
      // network retry into the same row.
      p_idempotency_key: data.idempotency_key || crypto.randomUUID(),
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

  const totalPaid = data.payments.reduce((sum, p) => sum + p.amount, 0);

  return {
    transaction: {
      id: rpcResult.transaction_id,
      branch_id: rpcResult.branch_id,
      created_at: new Date().toISOString(),
    },
    transactionNumber: rpcResult.transaction_number,
    change: rpcResult.change ?? Math.max(0, totalPaid - data.cart.total),
    isOffline: false,
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
  };
}
