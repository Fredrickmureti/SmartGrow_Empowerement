import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * ADR 0028 — Canonical vendor ledger read model (AP mirror of ADR 0027).
 *
 * Reads `vendor_ledger_entries` (a DB view that unions bills,
 * bill-payment allocations, and vendor credit notes) and computes a
 * running AP balance client-side.
 *
 * Convention: in the AP ledger, **credit** increases the vendor balance
 * (bill posted) and **debit** decreases it (payment / vendor credit).
 * Running balance therefore = Σ credit − Σ debit (positive = we owe
 * the vendor).
 *
 * This is the SINGLE SOURCE OF TRUTH for vendor statements and AP
 * aging going forward. Do NOT shadow-derive vendor balance from
 * `bills.amount_paid` + `bill_payments.amount` in new code.
 */
export type VendorLedgerDocType =
  | "bill"
  | "bill_payment"
  | "vendor_credit_note";

export interface VendorLedgerEntry {
  entry_date: string;
  doc_type: VendorLedgerDocType;
  doc_id: string;
  doc_ref: string;
  debit: number;
  credit: number;
  currency: string | null;
  branch_id: string | null;
  running_balance: number;
}

interface UseVendorLedgerArgs {
  contactId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  dateFrom?: string;
  dateTo?: string;
}

export function useVendorLedger({
  contactId,
  businessId,
  branchId,
  dateFrom,
  dateTo,
}: UseVendorLedgerArgs) {
  const query = useQuery({
    queryKey: ["vendor-ledger", contactId, businessId, branchId, dateFrom, dateTo],
    queryFn: async (): Promise<VendorLedgerEntry[]> => {
      if (!contactId) return [];
      let q = supabase
        .from("vendor_ledger_entries" as any)
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
        balance += credit - debit;
        return {
          entry_date: row.entry_date,
          doc_type: row.doc_type as VendorLedgerDocType,
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
