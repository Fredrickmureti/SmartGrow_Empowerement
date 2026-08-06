/**
 * POS Credit Sale Hook
 *
 * When a POS transaction is completed with "credit" payment method:
 * 1. Requires a customer (enforced here + UI)
 * 2. Creates the AR invoice through the single server-side writer
 *    `create_pos_credit_sale_invoice_atomic`: header, lines and the
 *    `pos_transactions.invoice_id` link are written in ONE transaction,
 *    idempotently by POS transaction id. The client never inserts into
 *    `invoices` / `invoice_items` — a partial saga could otherwise leave a
 *    completed sale with no receivable.
 * 3. Confirms it via the canonical `confirmInvoiceAndPostGL` path, so a POS
 *    on-account sale gets the SAME accounting treatment as a regular sales
 *    invoice: per-line revenue grouping, COGS, contact-level AR override and
 *    an idempotent atomic JE through `post_journal_entry_atomic`.
 */

import { supabase } from "@/integrations/supabase/client";
import { useGLPosting } from "@/hooks/useGLPosting";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useAuditLog } from "@/hooks/useAuditLog";
import { confirmInvoiceAndPostGL } from "@/hooks/invoices/confirmInvoiceGL";
import type { CartState } from "./usePOSCart";
import type { PaymentMethod } from "./usePOSTransactionOffline";

export function usePOSCreditSale() {
  const { postToGL } = useGLPosting();
  const {
    getInvoiceAccountMappings,
    hasRequiredAccounts,
    accounts: systemDefaults,
  } = useDefaultAccounts();
  const { logAction } = useAuditLog();

  /**
   * Returns true if any payment in the list is a credit payment.
   */
  const hasCreditPayment = (payments: PaymentMethod[]): boolean => {
    return payments.some((p) => p.method === "credit");
  };

  /**
   * Validates that credit sale requirements are met.
   * Throws if customer is missing.
   */
  const validateCreditSale = (cart: CartState, payments: PaymentMethod[]) => {
    if (!hasCreditPayment(payments)) return;

    if (!cart.customer?.id) {
      throw new Error(
        "A customer is required for credit sales. Please select a customer before completing this transaction."
      );
    }
  };

  /**
   * After a POS transaction completes with credit payment, materialises the
   * invoice server-side and confirms it through the canonical pipeline.
   *
   * Amounts, lines and branch context are derived by the RPC from the
   * committed POS transaction — the cart is only used for the pre-flight
   * customer check.
   */
  const processPostTransactionCredit = async (
    transactionId: string,
    _transactionNumber: string,
    _cart: CartState,
    payments: PaymentMethod[],
    userId: string
  ) => {
    if (!hasCreditPayment(payments)) return null;

    try {
      const { data: invoiceId, error: rpcError } = await supabase.rpc(
        "create_pos_credit_sale_invoice_atomic" as never,
        {
          _pos_transaction_id: transactionId,
          _user_id: userId,
        } as never,
      );
      if (rpcError) throw rpcError;
      if (!invoiceId) return null;

      const { data: invoice, error: readError } = await supabase
        .from("invoices")
        .select("*")
        .eq("id", invoiceId as unknown as string)
        .single();
      if (readError) throw readError;

      // Already confirmed by an earlier attempt — nothing further to post.
      if (invoice.status !== "draft") return invoice;

      // Confirm + post via the canonical pipeline (same as regular invoices).
      try {
        await confirmInvoiceAndPostGL(invoice as any, {
          postToGL,
          hasRequiredAccounts,
          getInvoiceAccountMappings,
          systemDefaults,
          logAction,
          userId,
        });
      } catch (confirmError) {
        console.error("POS credit-sale invoice confirmation failed:", confirmError);
        // The invoice document exists and is linked. The operator can retry
        // confirmation from the invoice screen; the POS sale itself stands.
      }

      return invoice;
    } catch (error) {
      console.error("Failed to create invoice for POS credit sale:", error);
      return null;
    }
  };

  return {
    hasCreditPayment,
    validateCreditSale,
    processPostTransactionCredit,
  };
}

