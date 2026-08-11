/**
 * useProductDetailData — two-phase composed fetch for ProductDetailPanel.
 *
 * Phase 1 (critical path): product + warehouse_stock + packaging — parallel.
 *   These feed the header, badges, intelligence strip, StatCards.
 *   The peek can render as soon as this resolves.
 *
 * Phase 2 (deferred): identifiers + reorder rules + lot quants + recent
 *   movements + open POs + 28d velocity — parallel, fired only after
 *   phase 1 completes. Tabs consume slices via placeholderData so they
 *   show skeletons instead of blocking the peek open.
 *
 * Same cache-key shape as before so downstream invalidations still hit.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { activeIdentifiersForProduct } from "@/features/products/identity/activeIdentifiers";


export interface ProductDetailData {
  product: any | null;
  warehouseStock: any[];
  warehouseStockLots: any[];
  packaging: any[];
  identifiers: any[];
  reorderRules: any[];
  recentMovements: any[];
  incomingPo: { totalQty: number; openOrders: number };
  velocityPerWeek: number;
}

interface Args {
  productId: string | null;
  organizationId: string | undefined;
  businessId: string | undefined;
  branchId: string | null;
  enabled?: boolean;
}

const EMPTY_DEFERRED = {
  warehouseStockLots: [] as any[],
  identifiers: [] as any[],
  reorderRules: [] as any[],
  recentMovements: [] as any[],
  incomingPo: { totalQty: 0, openOrders: 0 },
  velocityPerWeek: 0,
};

export function useProductDetailData({
  productId,
  organizationId,
  businessId,
  branchId,
  enabled = true,
}: Args) {
  // ─── Phase 1: critical path (header + intelligence strip) ────────────
  const critical = useQuery({
    queryKey: [
      "product-detail-panel",
      "critical",
      productId,
      organizationId,
      businessId,
      branchId,
    ],
    enabled: enabled && !!productId && !!organizationId && !!businessId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!productId || !organizationId || !businessId) {
        return { product: null, warehouseStock: [] as any[], packaging: [] as any[] };
      }

      let wsQ = (supabase as any)
        .from("warehouse_stock")
        .select("*, warehouses!inner(id, name, code, branch_id)")
        .eq("product_id", productId)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId);
      if (branchId) wsQ = wsQ.eq("warehouses.branch_id", branchId);

      const [productRes, wsRes, packagingRes] = await Promise.all([
        supabase.from("products").select("*").eq("id", productId).maybeSingle(),
        wsQ,
        supabase
          .from("product_packaging")
          .select("*")
          .eq("product_id", productId)
          .order("qty_in_base_uom", { ascending: false }),
      ]);

      if (productRes.error) throw productRes.error;
      if (wsRes.error) throw wsRes.error;

      return {
        product: productRes.data,
        warehouseStock: wsRes.data ?? [],
        packaging: packagingRes.data ?? [],
      };
    },
  });

  // ─── Phase 2: deferred (tabs) ────────────────────────────────────────
  const deferred = useQuery({
    queryKey: [
      "product-detail-panel",
      "deferred",
      productId,
      organizationId,
      businessId,
      branchId,
    ],
    enabled:
      enabled &&
      !!productId &&
      !!organizationId &&
      !!businessId &&
      !!critical.data?.product,
    staleTime: 30_000,
    placeholderData: EMPTY_DEFERRED,
    queryFn: async () => {
      if (!productId || !businessId || !organizationId) return EMPTY_DEFERRED;

      let lotsQ = (supabase as any)
        .from("warehouse_stock_lots")
        .select(
          "*, warehouses!inner(name, branch_id), stock_lots!inner(id, lot_number, expiry_date)",
        )
        .eq("product_id", productId)
        .eq("business_id", businessId)
        .gt("quantity", 0);
      if (branchId) lotsQ = lotsQ.eq("warehouses.branch_id", branchId);

      // Reorder rules are branch-scoped, not warehouse-scoped: the table has
      // its own `branch_id` and no relationship to `warehouses`. Embedding
      // `warehouses!inner(...)` here made PostgREST reject the request (400).
      let rrQ = (supabase as any)
        .from("product_reorder_rules")
        .select("*")
        .eq("product_id", productId)
        .eq("business_id", businessId);
      if (branchId) rrQ = rrQ.eq("branch_id", branchId);

      let mvQ = supabase
        .from("stock_movements")
        .select("*, warehouses(id, name)")
        .eq("product_id", productId)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("movement_date", { ascending: false })
        .limit(20);
      if (branchId) mvQ = mvQ.eq("branch_id", branchId);

      // Canonical expected supply: committed POs only (approved /
      // acknowledged / sent / partially received), unreceived quantity.
      // Single source of truth shared with the replenishment engine —
      // drafts are not supply. See ADR-0102.
      const poQ = supabase
        .from("inventory_expected_supply")
        .select("expected_quantity, open_po_count")
        .eq("product_id", productId)
        .eq("business_id", businessId);

      const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
      let velQ = supabase
        .from("stock_movements")
        .select("quantity, movement_type, movement_date")
        .eq("product_id", productId)
        .eq("business_id", businessId)
        .gte("movement_date", since);
      if (branchId) velQ = velQ.eq("branch_id", branchId);

      // Lifecycle-faithful: retired identifiers are archived rows, not deleted
      // ones. The overview shows canonical (live) identity only.
      const identifiersQ = activeIdentifiersForProduct(productId, "*");


      const [lotsRes, identifiersRes, rrRes, mvRes, poRes, velRes] =
        await Promise.all([lotsQ, identifiersQ, rrQ, mvQ, poQ, velQ]);

      // View rows are pre-aggregated per product / warehouse / branch —
      // just sum the buckets.
      let totalQty = 0;
      let openOrders = 0;
      for (const r of ((poRes as any).data ?? []) as any[]) {
        totalQty += Number(r.expected_quantity || 0);
        openOrders += Number(r.open_po_count || 0);
      }

      const outbound = ((velRes as any).data ?? [])
        .filter((m: any) => Number(m.quantity) < 0)
        .reduce(
          (s: number, m: any) => s + Math.abs(Number(m.quantity) || 0),
          0,
        );

      return {
        warehouseStockLots: (lotsRes as any).data ?? [],
        identifiers: (identifiersRes as any).data ?? [],
        reorderRules: (rrRes as any).data ?? [],
        recentMovements: (mvRes as any).data ?? [],
        incomingPo: { totalQty, openOrders },
        velocityPerWeek: outbound / 4,
      };
    },
  });

  const data: ProductDetailData | undefined = critical.data
    ? {
        product: critical.data.product,
        warehouseStock: critical.data.warehouseStock,
        packaging: critical.data.packaging,
        warehouseStockLots: deferred.data?.warehouseStockLots ?? [],
        identifiers: deferred.data?.identifiers ?? [],
        reorderRules: deferred.data?.reorderRules ?? [],
        recentMovements: deferred.data?.recentMovements ?? [],
        incomingPo: deferred.data?.incomingPo ?? { totalQty: 0, openOrders: 0 },
        velocityPerWeek: deferred.data?.velocityPerWeek ?? 0,
      }
    : undefined;

  return {
    data,
    isLoading: critical.isLoading,
    isDeferredLoading: deferred.isLoading || deferred.isFetching,
    error: critical.error ?? deferred.error ?? null,
  };
}
