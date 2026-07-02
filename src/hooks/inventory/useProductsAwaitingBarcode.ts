/**
 * useProductsAwaitingBarcode — paginated queue projection of products that
 * have no GTIN / pack identifier in `product_identifiers`. Source feed for
 * the Barcode Enrollment Workspace.
 *
 * - Business-scoped (multi-tenant invariant).
 * - Refresh model: the enrollment page invalidates the
 *   `["products-awaiting-barcode"]` query key after every successful
 *   enrol/undo, so the queue stays in sync without a manual refetch.
 *   Full realtime can be wired by mounting `useInventoryRealtime` from
 *   this page in a follow-up — today the post-mutation invalidation is
 *   the authoritative trigger.
 * - FIFO by created_at; the workflow reducer holds deferred-skip items in
 *   memory and appends them to the tail without persisting an ordering.
 */


import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface AwaitingBarcodeProduct {
  id: string;
  name: string;
  sku: string | null;
  unit_price: number;
  image_url: string | null;
  category_id: string | null;
}

interface Args {
  businessId: string | null | undefined;
  search?: string;
  limit?: number;
}

export function useProductsAwaitingBarcode({ businessId, search, limit = 200 }: Args) {
  return useQuery({
    queryKey: ["products-awaiting-barcode", businessId, search ?? null, limit],
    enabled: !!businessId,
    queryFn: async (): Promise<AwaitingBarcodeProduct[]> => {
      // Two-step: fetch product_ids that already have a scannable identifier,
      // then fetch products that are NOT in that set. PostgREST doesn't
      // expose a clean NOT EXISTS subquery, but this is bounded by the
      // business's identifier count and runs in a single round-trip pair.
      const { data: withIds, error: e1 } = await supabase
        .from("product_identifiers")
        .select("product_id")
        .eq("business_id", businessId!)
        .in("kind", ["gtin", "pack"]);
      if (e1) throw e1;
      const excludeIds = Array.from(new Set((withIds ?? []).map((r) => r.product_id)));

      let q = supabase
        .from("products")
        .select("id,name,sku,unit_price,image_url,category_id")
        .eq("business_id", businessId!)
        .eq("is_active", true)
        // Exclude products the operator already flagged for review — they
        // leave the workspace until reviewed (separate triage workflow).
        .is("review_reason", null)
        .order("created_at", { ascending: true })
        .limit(limit);

      if (excludeIds.length > 0) {
        // PostgREST: not.in.(...) — chunk to stay under URL length limits.
        // Realistically tenants have << 2000 identifiers, but be safe.
        const CHUNK = 500;
        for (let i = 0; i < excludeIds.length; i += CHUNK) {
          const slice = excludeIds.slice(i, i + CHUNK);
          q = q.not("id", "in", `(${slice.join(",")})`);
        }
      }
      if (search && search.trim().length > 0) {
        const s = search.trim().replace(/[,()]/g, " ");
        q = q.or(`name.ilike.%${s}%,sku.ilike.%${s}%`);
      }

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as AwaitingBarcodeProduct[];
    },
    staleTime: 30_000,
  });
}
