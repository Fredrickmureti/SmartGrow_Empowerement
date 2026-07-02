import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

/**
 * ADR 0027 — Canonical customer-receivable read model.
 *
 * Derives the receivable position from the canonical
 * `customer_ledger_entries` view (invoices + payment allocations +
 * unapplied deposits + credit notes + refunds). This replaces the
 * earlier shadow-derivation from `invoices.amount_paid` +
 * `payments.outstanding_amount`, which double-counted under partial
 * reallocations and cross-business allocations.
 *
 *   - openInvoices         : SUM(invoice.debit) − SUM(payment.credit
 *                            against invoices)  → strict AR.
 *   - outstandingCash      : SUM(deposit.credit) — unapplied cash.
 *   - unappliedCreditNotes : SUM(credit_note.credit) − refund debit.
 *   - netReceivable        : openInvoices − outstandingCash − unappliedCreditNotes.
 */
export interface CustomerOutstandingBalance {
  customerId: string;
  openInvoices: number;
  outstandingCash: number;
  unappliedCreditNotes: number;
  netReceivable: number;
}

export function useCustomerOutstandingBalance(customerId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const query = useQuery({
    queryKey: [
      "customer-outstanding-balance",
      customerId,
      currentOrg?.id,
      currentBusiness?.id,
    ],
    queryFn: async (): Promise<CustomerOutstandingBalance | null> => {
      if (!customerId || !currentOrg?.id || !currentBusiness?.id) return null;

      const { data, error } = await supabase
        .from("customer_ledger_entries" as any)
        .select("doc_type, debit, credit")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("contact_id", customerId);

      if (error) throw error;

      let invoiceDebit = 0;
      let paymentAgainstInvoice = 0;
      let outstandingCash = 0;
      let creditNoteCredit = 0;
      let refundDebit = 0;

      for (const row of (data ?? []) as unknown as Array<{
        doc_type: string;
        debit: number | string;
        credit: number | string;
      }>) {
        const debit = Number(row.debit) || 0;
        const credit = Number(row.credit) || 0;
        switch (row.doc_type) {
          case "invoice":
            invoiceDebit += debit;
            break;
          case "payment":
            paymentAgainstInvoice += credit;
            break;
          case "deposit":
            outstandingCash += credit;
            break;
          case "credit_note":
            creditNoteCredit += credit;
            break;
          case "refund":
            refundDebit += debit;
            break;
        }
      }

      const openInvoices = Math.max(0, invoiceDebit - paymentAgainstInvoice);
      const unappliedCreditNotes = Math.max(0, creditNoteCredit - refundDebit);

      return {
        customerId,
        openInvoices,
        outstandingCash,
        unappliedCreditNotes,
        netReceivable: openInvoices - outstandingCash - unappliedCreditNotes,
      };
    },
    enabled: !!customerId && !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 15_000,
  });

  return {
    balance: query.data ?? null,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
