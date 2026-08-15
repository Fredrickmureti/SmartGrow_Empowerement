/**
 * useDashboardIntelligence — branch-scoped intelligence aggregates for the
 * Inventory dashboard. Read-only; reuses primary tables (no new schema).
 *
 * - Expiring soon: reads the `v_lots_expiring_soon` view, branch-scoped.
 * - Negative stock: counts `warehouse_stock` rows with quantity < 0.
 * - Top movers (28d): top 5 products by outbound base qty in the last 28 days.
 *
 * Each query has a 60s staleTime so revisits feel instant without hammering
 * the database, matching the existing dashboard cadence.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { productBaseLabelOrUnset, PRODUCT_BASE_UOM_SELECT } from "@/lib/inventory/uom";

export interface DashboardIntelligence {
  expiringSoon: { count: number; sample: Array<{ id: string; name: string; days: number | null }> };
  negativeStock: { count: number; sample: Array<{ id: string; name: string; quantity: number; warehouse: string | null }> };
  topMovers: Array<{ productId: string; name: string; baseQty: number; uom: string }>;
}

export function useDashboardIntelligence() {
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  return useQuery<DashboardIntelligence>({
    queryKey: ["inventory-dashboard-intelligence", businessId, branchId],
    enabled: !!businessId,
    staleTime: 60_000,
    queryFn: async () => {
      const empty: DashboardIntelligence = {
        expiringSoon: { count: 0, sample: [] },
        negativeStock: { count: 0, sample: [] },
        topMovers: [],
      };
      if (!businessId) return empty;

      // 1. Expiring soon — the view embeds alert_window_days, so we just
      //    filter rows where days_to_expiry is within window.
      let expQ = supabase
        .from("v_lots_expiring_soon")
        .select("lot_id, product_id, product_name, days_to_expiry, alert_window_days, quantity_on_hand")
        .eq("business_id", businessId);
      const { data: expRows } = await expQ;
      const exp = (expRows ?? []).filter((r: any) => {
        if (Number(r.quantity_on_hand) <= 0) return false;
        const d = r.days_to_expiry;
        const w = r.alert_window_days ?? 30;
        return d != null && d <= Number(w);
      });
      const expSample = exp.slice(0, 5).map((r: any) => ({
        id: r.lot_id, name: r.product_name ?? "Lot", days: r.days_to_expiry,
      }));

      // 2. Negative stock
      let negQ = supabase
        .from("warehouse_stock")
        .select("id, product_id, quantity, products(name), warehouses(name)")
        .eq("business_id", businessId)
        .lt("quantity", 0);
      if (branchId) negQ = negQ.eq("branch_id", branchId);
      const { data: negRows } = await negQ;
      const negSample = (negRows ?? []).slice(0, 5).map((r: any) => ({
        id: r.id,
        name: r.products?.name ?? "Unknown",
        quantity: Number(r.quantity) || 0,
        warehouse: r.warehouses?.name ?? null,
      }));

      // 3. Top movers (28d outbound) — aggregate client-side over the
      //    branch-scoped slice; safe at typical row counts.
      const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
      let mvQ = supabase
        .from("stock_movements")
        .select(`product_id, quantity, products(name, ${PRODUCT_BASE_UOM_SELECT})`)
        .eq("business_id", businessId)
        .gte("movement_date", since)
        .lt("quantity", 0);
      if (branchId) mvQ = mvQ.eq("branch_id", branchId);
      const { data: mvRows } = await mvQ;
      const agg = new Map<string, { name: string; uom: string; qty: number }>();
      for (const r of (mvRows ?? []) as any[]) {
        const id = r.product_id;
        if (!id) continue;
        const cur = agg.get(id) ?? { name: r.products?.name ?? "Unknown", uom: productBaseLabelOrUnset(r.products as any), qty: 0 };
        cur.qty += Math.abs(Number(r.quantity) || 0);
        agg.set(id, cur);
      }
      const topMovers = Array.from(agg.entries())
        .map(([productId, v]) => ({ productId, name: v.name, baseQty: v.qty, uom: v.uom }))
        .sort((a, b) => b.baseQty - a.baseQty)
        .slice(0, 5);

      return {
        expiringSoon: { count: exp.length, sample: expSample },
        negativeStock: { count: (negRows ?? []).length, sample: negSample },
        topMovers,
      };
    },
  });
}