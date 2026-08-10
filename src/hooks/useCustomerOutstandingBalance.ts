import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

/**
 * ADR 0029 — Single AR balance engine.
 *
 * The receivable position is `Σ(debit − credit)` over the GL-anchored
 * `customer_ledger_entries` view. There is exactly ONE balance formula and it
 * does not branch on `doc_type`: every row that hits the AR control account —
 * invoice, allocation, unapplied deposit, credit note, refund, payment
 * reversal, manual journal — is counted by construction.
 *
 * The previous implementation switched on `doc_type` and therefore:
 *   - never matched `deposit` (the view emits unapplied cash as `payment`),
 *   - silently dropped `payment_reversal` and `journal` rows,
 *   - clamped negatives to zero, hiding customer-credit positions.
 * Do not reintroduce a per-doc_type switch here.
 *
 *   - netReceivable : Σ(debit − credit). Positive = owed by customer.
 *   - openInvoices  : the positive part of netReceivable.
 *   - customerCredit: the absolute negative part (credit on file).
 */
export interface CustomerOutstandingBalance {
  customerId: string;
  /** Positive receivable exposure (0 when the customer is in credit). */
  openInvoices: number;
  /** Credit on file — unapplied cash and unapplied credit notes combined. */
  customerCredit: number;
  /** @deprecated split of cash vs credit-note credit is not GL-derivable here. */
  outstandingCash: number;
  /** @deprecated see `customerCredit`. */
  unappliedCreditNotes: number;
  /** Σ(debit − credit) — the canonical signed position. */
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
        .select("debit, credit")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("contact_id", customerId);

      if (error) throw error;

      let netReceivable = 0;
      for (const row of (data ?? []) as unknown as Array<{
        debit: number | string;
        credit: number | string;
      }>) {
        netReceivable += (Number(row.debit) || 0) - (Number(row.credit) || 0);
      }
      netReceivable = Math.round(netReceivable * 100) / 100;

      const customerCredit = netReceivable < 0 ? -netReceivable : 0;

      return {
        customerId,
        openInvoices: Math.max(0, netReceivable),
        customerCredit,
        outstandingCash: customerCredit,
        unappliedCreditNotes: 0,
        netReceivable,
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
