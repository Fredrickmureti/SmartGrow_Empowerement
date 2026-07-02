/**
 * useWarehouseStockTotals — branch-true stock valuation.
 *
 * Per ARCHITECTURE.md, `products.stock_quantity` is a *company-wide aggregate*
 * maintained by the `update_product_stock` trigger. It MUST NOT be used to
 * compute branch-scoped values: at branch B it would silently surface the
 * company total. This hook reads `warehouse_stock` — the per-(warehouse,
 * product) source of truth — and aggregates by `(business_id, branch_id?)`.
 *
 * Returns:
 *  - totalStockValue   : Σ qty × cost_price  (cost basis)
 *  - totalRetailValue  : Σ qty × unit_price  (retail basis)
 *  - totalQuantity     : Σ qty
 *  - productCount      : distinct product_ids with on-hand > 0
 *  - scopeLabel        : "Branch X" or "Company-wide" — for UI disclosure
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranches } from "./useBranches";

export interface WarehouseStockTotals {
  totalStockValue: number;
  totalRetailValue: number;
  totalQuantity: number;
  productCount: number;
  scopeLabel: string;
  branchScoped: boolean;
  isLoading: boolean;
}

export function useWarehouseStockTotals(opts?: { branchScoped?: boolean }): WarehouseStockTotals {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  // Default: scope to active branch when one is selected.
  const branchScoped = opts?.branchScoped ?? !!currentBranch?.id;
  const branchId = branchScoped ? currentBranch?.id ?? null : null;

  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;

  const { data, isLoading } = useQuery({
    queryKey: ["warehouse-stock-totals", orgId, bizId, branchId],
    queryFn: async () => {
      if (!orgId || !bizId) {
        return { totalStockValue: 0, totalRetailValue: 0, totalQuantity: 0, productCount: 0 };
      }
      let q = supabase
        .from("warehouse_stock")
        .select(`
          product_id,
          quantity,
          products!inner(id, cost_price, unit_price, type, is_active, business_id)
        `)
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .eq("products.is_active", true)
        .eq("products.type", "product");

      if (branchId) q = q.eq("branch_id", branchId);

      const { data: rows, error } = await q;
      if (error) throw error;

      let cost = 0;
      let retail = 0;
      let qty = 0;
      const productIds = new Set<string>();
      for (const r of (rows || []) as any[]) {
        const p = r.products;
        const onHand = Number(r.quantity) || 0;
        if (onHand <= 0) continue;
        cost += onHand * (Number(p?.cost_price) || 0);
        retail += onHand * (Number(p?.unit_price) || 0);
        qty += onHand;
        productIds.add(r.product_id);
      }
      return {
        totalStockValue: cost,
        totalRetailValue: retail,
        totalQuantity: qty,
        productCount: productIds.size,
      };
    },
    enabled: !!orgId && !!bizId,
  });

  const scopeLabel = branchScoped && currentBranch?.name
    ? `Branch: ${currentBranch.name}`
    : "Company-wide";

  return {
    totalStockValue: data?.totalStockValue ?? 0,
    totalRetailValue: data?.totalRetailValue ?? 0,
    totalQuantity: data?.totalQuantity ?? 0,
    productCount: data?.productCount ?? 0,
    scopeLabel,
    branchScoped,
    isLoading,
  };
}