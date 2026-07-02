import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

/**
 * ADR 0012 — Wave R3.
 *
 * Returns the list of customer payments that still carry unapplied cash
 * (i.e. parked on the Customer Deposits liability account via the
 * wizard's `wrong_invoice_applied` → unapply path, or recorded directly
 * as an advance with no invoice).
 *
 * Single source of truth for the Apply-Deposit UI surface. Never derive
 * "unapplied" by subtracting from `payments.amount` elsewhere — the
 * canonical split lives in `payments.outstanding_amount`.
 */
export interface UnappliedDeposit {
  id: string;
  receipt_number: string | null;
  payment_date: string;
  amount: number;
  outstanding_amount: number;
  applied_amount: number;
  contact_id: string | null;
  payment_method: string;
}

export function useCustomerUnappliedDeposits(contactId?: string | null) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const query = useQuery({
    queryKey: [
      "customer-unapplied-deposits",
      contactId ?? "all",
      currentOrg?.id,
      currentBusiness?.id,
    ],
    queryFn: async (): Promise<UnappliedDeposit[]> => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      let q = supabase
        .from("payments")
        .select(
          "id, receipt_number, payment_date, amount, outstanding_amount, applied_amount, contact_id, payment_method, status",
        )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .neq("status", "voided")
        .gt("outstanding_amount", 0)
        .order("payment_date", { ascending: false });

      if (contactId) q = q.eq("contact_id", contactId);

      const { data, error } = await q;
      if (error) throw error;

      return (data ?? []).map((p: any) => ({
        id: p.id,
        receipt_number: p.receipt_number,
        payment_date: p.payment_date,
        amount: Number(p.amount) || 0,
        outstanding_amount: Number(p.outstanding_amount) || 0,
        applied_amount: Number(p.applied_amount) || 0,
        contact_id: p.contact_id,
        payment_method: p.payment_method,
      }));
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 15_000,
  });

  const deposits = query.data ?? [];
  const totalUnapplied = deposits.reduce((s, d) => s + d.outstanding_amount, 0);

  return {
    deposits,
    totalUnapplied,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
