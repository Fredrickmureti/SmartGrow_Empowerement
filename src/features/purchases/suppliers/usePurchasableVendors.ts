import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";

/**
 * Supplier lifecycle states that may NOT receive new procurement documents.
 * The database enforces this too (gate triggers on PO / bill / RFQ invite);
 * this hook keeps the UI from offering a party the server will reject.
 */
export const NON_PURCHASABLE_LIFECYCLE = ["suspended", "blocked", "archived"] as const;

/**
 * Returns the set of contact ids whose supplier role is currently held.
 * Contacts with no supplier row at all are NOT held — the party-role trigger
 * provisions the role on first procurement use.
 */
export function useHeldSupplierContactIds() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const { data } = useQuery({
    queryKey: ["held-supplier-contacts", businessId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("suppliers")
        .select("contact_id, lifecycle_state")
        .eq("business_id", businessId)
        .in("lifecycle_state", NON_PURCHASABLE_LIFECYCLE as unknown as string[]);
      if (error) throw error;
      return new Set<string>(((data ?? []) as any[]).map((r) => r.contact_id));
    },
    enabled: !!businessId,
    staleTime: 60_000,
  });

  return data ?? new Set<string>();
}

type VendorLike = { id: string; type?: string | null; is_active?: boolean | null };

/**
 * Canonical vendor picker source: active supplier-role parties minus any party
 * whose supplier role is suspended, blocked or archived.
 */
export function usePurchasableVendors<T extends VendorLike>(contacts: T[]): T[] {
  const held = useHeldSupplierContactIds();
  return contacts.filter(
    (c) =>
      (c.type === "supplier" || c.type === "both") &&
      c.is_active !== false &&
      !held.has(c.id),
  );
}
