import { normalizeError } from "@/services/resilience";
/**
 * POS Invoice Request Hook (Odoo-style)
 *
 * Allows any completed POS transaction (even cash) to optionally generate
 * a formal invoice in the invoices table. Matches Odoo's "Invoice" button on POS.
 *
 * ADR 0128 — the document itself is created by ONE server-side writer,
 * `create_pos_credit_sale_invoice_atomic(_mode := 'full')`: header, lines and
 * the `pos_transactions.invoice_id` link land in a single transaction and are
 * idempotent by POS transaction id. This hook only collects context, then
 * settles the recorded tenders through the canonical allocation contract
 * (`record_payment_atomic`, ADR 0027). It never inserts invoice rows or
 * reserves invoice numbers on the client.
 */

import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";

interface POSTransactionForInvoice {
  id: string;
  transaction_number: string;
  customer_id?: string | null;
  customer_name?: string;
  total_amount: number;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  invoice_id?: string | null;
}

export function usePOSInvoiceRequest() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const { accounts, getPaymentAccountForMethod } = useDefaultAccounts() as any;
  const [isGenerating, setIsGenerating] = useState(false);

  /**
   * Check if a POS transaction already has an invoice linked.
   */
  const hasInvoice = (transaction: POSTransactionForInvoice): boolean => {
    return !!transaction.invoice_id;
  };

  /**
   * Generate a formal invoice from a completed POS transaction.
   * Returns the created invoice ID, or null on failure.
   */
  const generateInvoice = async (transactionId: string): Promise<string | null> => {
    if (!currentOrg?.id) {
      toast({ title: "Error", description: "Organization not found", variant: "destructive" });
      return null;
    }

    setIsGenerating(true);
    try {
      // Read-only context for the settlement leg and the operator message.
      const { data: txn, error: txnError } = await supabase
        .from("pos_transactions")
        .select("*, customer:contacts(id, name)")
        .eq("id", transactionId)
        .single();

      if (txnError || !txn) throw new Error("Transaction not found");

      if (!txn.customer_id) {
        toast({
          title: "Customer required",
          description: "Please assign a customer to this transaction before generating an invoice.",
          variant: "destructive",
        });
        return null;
      }

      if (txn.invoice_id) {
        toast({ title: "Invoice exists", description: "This transaction already has an invoice." });
        return txn.invoice_id;
      }

      const { data: { user } } = await supabase.auth.getUser();

      // Single writer: header + lines + POS link, one transaction, idempotent.
      const { data: newInvoiceId, error: rpcError } = await supabase.rpc(
        "create_pos_credit_sale_invoice_atomic" as never,
        {
          _pos_transaction_id: transactionId,
          _due_days: 0,
          _user_id: user?.id ?? null,
          _mode: "full",
        } as never,
      );
      if (rpcError) throw rpcError;
      const invoiceId = newInvoiceId as unknown as string | null;
      if (!invoiceId) throw new Error("Invoice was not created");

      const { data: invoice } = await supabase
        .from("invoices")
        .select("id, invoice_number")
        .eq("id", invoiceId)
        .single();

      // Settle the invoice through the canonical allocation contract.
      // Pulls one payments row + one payment_allocations row per tender in
      // pos_transaction_payments. Falls back to a single 'cash' tender if
      // the POS transaction recorded no payment rows (legacy data).
      const { data: tenders } = await supabase
        .from("pos_transaction_payments")
        .select("payment_method, amount, status")
        .eq("transaction_id", transactionId)
        .gt("amount", 0);

      const settlements: Array<{ method: string; amount: number }> = (tenders || [])
        .filter((t: any) => (t.status ?? "completed") === "completed")
        .map((t: any) => ({ method: String(t.payment_method || "cash"), amount: Number(t.amount) }));
      if (settlements.length === 0) {
        settlements.push({ method: "cash", amount: Number(txn.total || 0) });
      }

      const receivableAccountId = accounts?.accounts_receivable_id || null;
      if (!receivableAccountId) {
        // Invoice was created confirmed/unpaid; warn but don't roll back.
        // The ledger will show an outstanding invoice with no payment until
        // Default Accounts are mapped and the cashier re-records the payment.
        toast({
          title: "Invoice created, payment not recorded",
          description:
            "Accounts Receivable account is not mapped. Map it in Settings > Default Accounts and re-record the payment from the invoice.",
          variant: "destructive",
        });
      } else {
        for (const [tenderIndex, s] of settlements.entries()) {
          const depositAccountId = getPaymentAccountForMethod?.(s.method) || accounts?.cash_account_id || accounts?.bank_account_id;
          if (!depositAccountId) continue;
          const { data: receiptNumberData } = await supabase.rpc("get_next_receipt_number", {
            _org_id: currentOrg.id,
            _business_id: (currentBusiness?.id ?? (txn as any).business_id) as string,
            _branch_id: (txn as any).branch_id ?? null,
          } as any);
          const { error: payErr } = await supabase.rpc("record_payment_atomic", {
            _org_id: currentOrg.id,
            _business_id: (currentBusiness?.id ?? (txn as any).business_id) as string,
            _contact_id: txn.customer_id,
            _invoice_id: invoiceId,
            _amount: s.amount,
            _payment_date: new Date(txn.created_at).toISOString().split("T")[0],
            _payment_method: s.method,
            _reference: txn.transaction_number,
            _notes: `POS tender ${s.method} for ${txn.transaction_number}`,
            _receipt_number: receiptNumberData || `POS-${Date.now()}`,
            _created_by: user?.id,
            _deposit_account_id: depositAccountId,
            _receivable_account_id: receivableAccountId,
            // Deterministic per POS tender: re-running invoice generation for
            // the same transaction can never double-record the same tender.
            _request_id: `pos:${txn.id}:${tenderIndex}`,
          } as any);

          if (payErr) {
            console.error("[usePOSInvoiceRequest] record_payment_atomic failed:", payErr);
            toast({
              title: "Payment leg failed",
              description: payErr.message || "Could not record POS tender as invoice payment",
              variant: "destructive",
            });
          }
        }
      }

      toast({
        title: "Invoice generated",
        description: `Invoice ${invoice?.invoice_number ?? ""} created from POS transaction ${txn.transaction_number}`.trim(),
      });

      return invoiceId;
    } catch (error: any) {
      console.error("Failed to generate invoice from POS transaction:", error);
      toast({
        title: "Invoice generation failed",
        description: normalizeError(error).message || "Unknown error",
        variant: "destructive",
      });
      return null;
    } finally {
      setIsGenerating(false);
    }
  };

  return {
    isGenerating,
    hasInvoice,
    generateInvoice,
  };
}
