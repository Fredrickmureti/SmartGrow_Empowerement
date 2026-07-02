import { normalizeError } from "@/services/resilience";
/**
 * POS Invoice Request Hook (Odoo-style)
 * 
 * Allows any completed POS transaction (even cash) to optionally generate
 * a formal invoice in the invoices table. Matches Odoo's "Invoice" button on POS.
 * 
 * Requires a customer to be associated with the transaction.
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
      // Fetch the POS transaction with items
      const { data: txn, error: txnError } = await supabase
        .from("pos_transactions")
        .select("*, customer:contacts(id, name)")
        .eq("id", transactionId)
        .single();

      if (txnError || !txn) throw new Error("Transaction not found");
      if (!(txn as any).branch_id) throw new Error("POS transaction is missing branch context");

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

      // Fetch items
      const { data: items } = await supabase
        .from("pos_transaction_items")
        .select("*")
        .eq("transaction_id", transactionId)
        .order("sort_order");

      // Get next invoice number
      const { data: invoiceNumber, error: numError } = await supabase.rpc(
        "get_next_invoice_number",
        { _org_id: currentOrg.id, _business_id: (currentBusiness?.id ?? (txn as any).business_id) as string },
      );
      if (numError) throw numError;

      // Get current user
      const { data: { user } } = await supabase.auth.getUser();

      // Create the invoice as "confirmed" with amount_paid=0. The settlement
      // leg below routes through `record_payment_atomic` which inserts the
      // `payments` row + `payment_allocations` row, flips status → paid, and
      // updates `amount_paid`. This is the ADR 0027 contract; writing
      // status='paid' here directly would re-create the "ledger doesn't see
      // the cash leg" defect for every POS-originated invoice.
      const { data: invoice, error: invoiceError } = await supabase
        .from("invoices")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id || txn.business_id,
          branch_id: (txn as any).branch_id,
          contact_id: txn.customer_id,
          invoice_number: invoiceNumber,
          status: "confirmed" as any,
          issue_date: new Date(txn.created_at).toISOString().split("T")[0],
          due_date: new Date(txn.created_at).toISOString().split("T")[0],
          subtotal: txn.subtotal || 0,
          tax_amount: txn.tax_amount || 0,
          discount_amount: txn.discount_amount || 0,
          total: txn.total || 0,
          amount_paid: 0,
          currency: currentBusiness?.base_currency,
          notes: `Generated from POS transaction ${txn.transaction_number}`,
          source: 'pos',
          created_by: user?.id,
          salesperson_id: user?.id,
          confirmed_by: user?.id,
        } as any)
        .select()
        .single();

      if (invoiceError) throw invoiceError;

      // Insert invoice line items
      if (items && items.length > 0) {
        const invoiceItems = items.map((item: any, index: number) => ({
          invoice_id: invoice.id,
          product_id: item.product_id,
          description: item.product_name,
          quantity: item.quantity,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate || 0,
          tax_amount: item.tax_amount || 0,
          discount_percent: item.discount_amount && item.unit_price > 0
            ? ((item.discount_amount / (item.quantity * item.unit_price)) * 100)
            : 0,
          line_total: item.line_total,
          sort_order: index,
        }));

        await supabase.from("invoice_items").insert(invoiceItems);
      }

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
        for (const s of settlements) {
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
            _invoice_id: invoice.id,
            _amount: s.amount,
            _payment_date: new Date(txn.created_at).toISOString().split("T")[0],
            _payment_method: s.method,
            _reference: txn.transaction_number,
            _notes: `POS tender ${s.method} for ${txn.transaction_number}`,
            _receipt_number: receiptNumberData || `POS-${Date.now()}`,
            _created_by: user?.id,
            _deposit_account_id: depositAccountId,
            _receivable_account_id: receivableAccountId,
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

      // Link invoice to POS transaction
      await supabase
        .from("pos_transactions")
        .update({ invoice_id: invoice.id })
        .eq("id", transactionId)
        .eq("branch_id", (txn as any).branch_id); // branch-bind

      toast({
        title: "Invoice generated",
        description: `Invoice ${invoiceNumber} created from POS transaction ${txn.transaction_number}`,
      });

      return invoice.id;
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
