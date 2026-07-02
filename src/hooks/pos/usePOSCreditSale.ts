/**
 * POS Credit Sale Hook
 *
 * When a POS transaction is completed with "credit" payment method:
 * 1. Requires a customer (enforced here + UI)
 * 2. Auto-generates an invoice and confirms it via the canonical
 *    `confirmInvoiceAndPostGL` path — this gives POS-on-account sales the
 *    SAME accounting treatment as regular sales invoices:
 *      - per-line revenue account grouping
 *      - COGS posting for inventory-tracked products
 *      - contact-level AR account override
 *      - idempotent atomic JE via post_journal_entry_atomic
 * 3. Links the invoice to pos_transactions.invoice_id
 */

import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useGLPosting } from "@/hooks/useGLPosting";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useAuditLog } from "@/hooks/useAuditLog";
import { confirmInvoiceAndPostGL } from "@/hooks/invoices/confirmInvoiceGL";
import type { CartState } from "./usePOSCart";
import type { PaymentMethod } from "./usePOSTransactionOffline";

export function usePOSCreditSale() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
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
   * After a POS transaction completes with credit payment,
   * creates an invoice (as draft) and confirms it via the canonical pipeline.
   */
  const processPostTransactionCredit = async (
    transactionId: string,
    transactionNumber: string,
    cart: CartState,
    payments: PaymentMethod[],
    userId: string
  ) => {
    if (!hasCreditPayment(payments)) return null;
    if (!currentOrg?.id || !currentBusiness?.id) return null;

    const creditAmount = payments
      .filter((p) => p.method === "credit")
      .reduce((sum, p) => sum + p.amount, 0);

    if (creditAmount <= 0) return null;

    try {
      const { data: posTransaction, error: txnError } = await supabase
        .from("pos_transactions")
        .select("branch_id, register:pos_registers(branch_id)")
        .eq("id", transactionId)
        .single();
      if (txnError) throw txnError;

      const registerBranch = (posTransaction as any)?.register?.branch_id;
      const invoiceBranchId = (posTransaction as any)?.branch_id ?? registerBranch;
      if (!invoiceBranchId) {
        throw new Error("POS transaction is missing register branch context");
      }

      // Get next invoice number
      const { data: invoiceNumber, error: numError } = await supabase.rpc(
        "get_next_invoice_number",
        { _org_id: currentOrg.id, _business_id: currentBusiness.id }
      );
      if (numError) throw numError;

      // Calculate line item totals
      let subtotal = 0;
      let taxAmount = 0;
      for (const item of cart.items) {
        const itemGross = item.quantity * item.unit_price;
        let itemDiscount = 0;
        if (item.discount_type === "percent") {
          itemDiscount = itemGross * (item.discount_value / 100);
        } else if (item.discount_type === "fixed") {
          itemDiscount = item.discount_value;
        }
        subtotal += itemGross - itemDiscount;
        taxAmount += item.tax_amount;
      }

      // Create invoice as DRAFT — confirmInvoiceAndPostGL will flip it to confirmed
      // and post the JE atomically with per-line revenue + COGS.
      const { data: invoice, error: invoiceError } = await supabase
        .from("invoices")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          branch_id: invoiceBranchId,
          contact_id: cart.customer!.id,
          invoice_number: invoiceNumber,
          status: "draft",
          source: "pos",
          issue_date: new Date().toISOString().split("T")[0],
          due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
          subtotal,
          tax_amount: taxAmount,
          discount_amount: cart.discount_amount,
          total: creditAmount,
          amount_paid: 0,
          currency: currentBusiness.base_currency,
          notes: `[POS] Auto-generated from POS transaction ${transactionNumber}`,
          created_by: userId,
          salesperson_id: userId,
        } as any)
        .select()
        .single();

      if (invoiceError) throw invoiceError;

      // Insert invoice line items (needed by confirmInvoiceAndPostGL for per-line accounts)
      const invoiceItems = cart.items.map((item, index) => ({
        invoice_id: invoice.id,
        product_id: item.product_id,
        description: item.name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
        tax_amount: item.tax_amount,
        discount_percent: item.discount_percent || 0,
        line_total: item.line_total,
        sort_order: index,
      }));

      if (invoiceItems.length > 0) {
        const { error: itemsError } = await supabase
          .from("invoice_items")
          .insert(invoiceItems);
        if (itemsError) {
          console.error("Failed to insert invoice items for POS credit sale:", itemsError);
          throw itemsError;
        }
      }

      // Link invoice to POS transaction immediately (so it shows even if JE posting fails)
      await supabase
        .from("pos_transactions")
        .update({ invoice_id: invoice.id })
        .eq("id", transactionId)
        .eq("branch_id", invoiceBranchId); // branch-bind

      // Confirm + post via the canonical pipeline (same as regular invoices).
      // This handles per-line revenue grouping, COGS, customer AR override,
      // idempotency, and atomic JE posting in one go.
      try {
        await confirmInvoiceAndPostGL(
          { ...invoice, status: "draft" } as any,
          {
            postToGL,
            hasRequiredAccounts,
            getInvoiceAccountMappings,
            systemDefaults,
            logAction,
            userId,
          }
        );
      } catch (confirmError) {
        console.error("POS credit-sale invoice confirmation failed:", confirmError);
        // Invoice + items are saved and linked. The user can retry confirmation
        // from the invoice screen. We don't fail the POS transaction itself.
      }

      return invoice;
    } catch (error) {
      console.error("Failed to create invoice for POS credit sale:", error);
      // Return null — the POS transaction itself succeeded, invoice creation is best-effort
      return null;
    }
  };

  return {
    hasCreditPayment,
    validateCreditSale,
    processPostTransactionCredit,
  };
}
