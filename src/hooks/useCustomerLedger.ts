import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * ADR 0027 — Canonical customer ledger read model.
 *
 * Reads `customer_ledger_entries` (a DB view that unions invoices,
 * payment allocations, customer deposits, credit notes, and refunds)
 * and computes a running balance client-side so callers can filter
 * by branch / date range without invalidating the cached running
 * balance.
 *
 * This is the SINGLE SOURCE OF TRUTH for customer balance, customer
 * statements, and aging. Do NOT shadow-derive customer balance from
 * `invoices.amount_paid` + `payments.outstanding_amount` in new code.
 */
export type LedgerDocType =
  | "invoice"
  | "payment"
  | "deposit"
  | "credit_note"
  | "refund"
  | "payment_reversal"
  | "journal";

export interface LedgerEntry {
  entry_date: string;
  doc_type: LedgerDocType;
  doc_id: string;
  doc_ref: string;
  debit: number;
  credit: number;
  currency: string | null;
  branch_id: string | null;
  running_balance: number;
}

interface UseCustomerLedgerArgs {
  contactId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  dateFrom?: string;
  dateTo?: string;
}

export function useCustomerLedger({
  contactId,
  businessId,
  branchId,
  dateFrom,
  dateTo,
}: UseCustomerLedgerArgs) {
  const query = useQuery({
    queryKey: ["customer-ledger", contactId, businessId, branchId, dateFrom, dateTo],
    queryFn: async (): Promise<LedgerEntry[]> => {
      if (!contactId) return [];
      let q = supabase
        .from("customer_ledger_entries" as any)
        .select("*")
        .eq("contact_id", contactId)
        .order("entry_date", { ascending: true })
        .order("created_at", { ascending: true });
      if (businessId) q = q.eq("business_id", businessId);
      if (branchId) q = q.eq("branch_id", branchId);
      if (dateFrom) q = q.gte("entry_date", dateFrom);
      if (dateTo) q = q.lte("entry_date", dateTo);

      const { data, error } = await q;
      if (error) throw error;

      let balance = 0;
      return (data ?? []).map((row: any) => {
        const debit = Number(row.debit) || 0;
        const credit = Number(row.credit) || 0;
        balance += debit - credit;
        return {
          entry_date: row.entry_date,
          doc_type: row.doc_type as LedgerDocType,
          doc_id: row.doc_id,
          doc_ref: row.doc_ref,
          debit,
          credit,
          currency: row.currency ?? null,
          branch_id: row.branch_id ?? null,
          running_balance: balance,
        };
      });
    },
    enabled: !!contactId,
    staleTime: 30_000,
  });

  const entries = query.data ?? [];
  const outstandingBalance = entries.length
    ? entries[entries.length - 1].running_balance
    : 0;

  return {
    entries,
    outstandingBalance,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
