import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

/**
 * ADR 0028 — D6.1. AP mirror of `useCustomerUnappliedDeposits`.
 *
 * Returns supplier payments that still carry unapplied cash (money already
 * out of the bank, parked on the Vendor Credits asset account).
 *
 * `bill_payments` has no `outstanding_amount` column — the split is derived
 * from the append-only allocation ledger, exactly once, in the
 * `vendor_unapplied_advances` view. Never re-derive it by summing
 * `bill_payment_allocations` in component code.
 */
export interface UnappliedVendorAdvance {
  id: string;
  vendor_id: string | null;
  vendor_name: string | null;
  payment_date: string;
  payment_method: string | null;
  reference: string | null;
  amount: number;
  applied_amount: number;
  outstanding_amount: number;
}

export function useVendorUnappliedAdvances(vendorId?: string | null) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const query = useQuery({
    queryKey: [
      "vendor-unapplied-advances",
      vendorId ?? "all",
      currentOrg?.id,
      currentBusiness?.id,
    ],
    queryFn: async (): Promise<UnappliedVendorAdvance[]> => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      let q = supabase
        .from("vendor_unapplied_advances" as never)
        .select(
          "id, vendor_id, payment_date, payment_method, reference, amount, applied_amount, outstanding_amount",
        )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("payment_date", { ascending: false });

      if (vendorId) q = q.eq("vendor_id", vendorId);

      const { data, error } = await q;
      if (error) throw error;

      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      const vendorIds = Array.from(
        new Set(rows.map((r) => r["vendor_id"] as string | null).filter(Boolean) as string[]),
      );

      let names = new Map<string, string>();
      if (vendorIds.length > 0) {
        const { data: contacts } = await supabase
          .from("contacts")
          .select("id, name")
          .in("id", vendorIds);
        names = new Map((contacts ?? []).map((c) => [c.id as string, c.name as string]));
      }

      return rows.map((r) => ({
        id: r["id"] as string,
        vendor_id: (r["vendor_id"] as string | null) ?? null,
        vendor_name: r["vendor_id"] ? names.get(r["vendor_id"] as string) ?? null : null,
        payment_date: r["payment_date"] as string,
        payment_method: (r["payment_method"] as string | null) ?? null,
        reference: (r["reference"] as string | null) ?? null,
        amount: Number(r["amount"]) || 0,
        applied_amount: Number(r["applied_amount"]) || 0,
        outstanding_amount: Number(r["outstanding_amount"]) || 0,
      }));
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 15_000,
  });

  const advances = query.data ?? [];
  const totalUnapplied = advances.reduce((s, a) => s + a.outstanding_amount, 0);

  return {
    advances,
    totalUnapplied,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
