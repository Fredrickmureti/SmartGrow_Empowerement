/**
 * useBranchScopedProducts — branch-true product + on-hand stock for sales forms.
 *
 * Why this exists: `products.stock_quantity` is a *company-wide aggregate*
 * maintained by the `update_product_stock` trigger (see
 * `useWarehouseStockTotals.ts` and `ARCHITECTURE.md`). Using it inside a
 * branch-scoped sales form silently surfaces the company total — a Branch A
 * cashier sees HQ's 200 instead of Branch A's 30. That contaminates both the
 * displayed availability AND the oversell guard.
 *
 * This hook calls the `list_products_with_branch_stock` RPC, which delegates
 * to the canonical server availability engine per (business, branch) and
 * returns each product with
 *   - `on_hand`   — total quantity in scope
 *   - `reserved`  — already-reserved quantity in scope
 *   - `available` — server-resolved availability (validate sales against this)
 *
 * Query key includes `branch_id` so context switches invalidate cleanly.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranches } from "./useBranches";

export interface BranchScopedProduct {
  id: string;
  organization_id: string;
  business_id: string | null;
  type: "product" | "service";
  name: string;
  description: string | null;
  sku: string | null;
  unit_price: number;
  cost_price: number | null;
  tax_rate: number | null;
  tax_rate_id: string | null;
  is_active: boolean;
  image_url: string | null;
  category_id: string | null;
  track_inventory: boolean | null;
  reorder_level: number | null;
  min_order_quantity: number | null;
  order_quantity_increment: number | null;
  sales_account_id: string | null;
  cogs_account_id: string | null;
  inventory_account_id: string | null;
  purchase_account_id: string | null;
  // Unit-of-measure seam — sales lines quote a customer unit and the server
  // converts it to base units (see useSellableUnits / PackagedQtyCell).
  base_uom_id: string | null;
  base_uom_code: string | null;
  base_uom_name: string | null;
  sales_uom_id: string | null;
  sales_uom_code: string | null;
  sales_uom_name: string | null;
  packaging: Array<{
    id: string;
    name: string;
    qty_in_base_uom: number;
    is_sales_default?: boolean | null;
  }> | null;
  // Branch-aware stock figures
  on_hand: number;
  reserved: number;
  available: number;
  // Back-compat alias so existing callers reading `stock_quantity` keep working
  // while we migrate the codebase. NEW callers should use `available`.
  stock_quantity: number;
  branch_scope_label: string;
}

export interface UseBranchScopedProductsOptions {
  /**
   * Include `is_variant_parent = true` rows. Defaults to `false` (ADR 0072).
   * The RPC now filters server-side via `p_include_variant_parents`.
   */
  includeVariantParents?: boolean;
  /**
   * Phase 6b — narrow the figures to ONE warehouse.
   *
   * A Sales document reserves and issues stock from a single warehouse, so an
   * editor that has recorded that decision must read the same warehouse's
   * availability rather than the branch aggregate. `null`/omitted keeps the
   * branch-wide behaviour. The server validates the id
   * (`resolve_sales_warehouse`) and falls back to the branch default.
   */
  warehouseId?: string | null;
}

export function useBranchScopedProducts(
  options: UseBranchScopedProductsOptions = {},
) {
  const { includeVariantParents = false, warehouseId = null } = options;
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const query = useQuery({
    queryKey: [
      "products-branch-scoped",
      orgId,
      businessId,
      branchId,
      includeVariantParents,
      warehouseId,
    ],
    queryFn: async (): Promise<BranchScopedProduct[]> => {
      if (!orgId || !businessId) return [];
      const rpcRes = await supabase.rpc(
        "list_products_with_branch_stock" as any,
        {
          p_org_id: orgId,
          p_business_id: businessId,
          p_branch_id: branchId,
          p_include_variant_parents: includeVariantParents,
          p_warehouse_id: warehouseId,
        } as any,
      );
      if (rpcRes.error) throw rpcRes.error;
      const rows = ((rpcRes.data as any[]) || []).map((r) => ({
        ...r,
        on_hand: Number(r.on_hand) || 0,
        reserved: Number(r.reserved) || 0,
        available: Number(r.available) || 0,
        // Back-compat: legacy callers reading `.stock_quantity` get the
        // branch-scoped on-hand instead of the company aggregate.
        stock_quantity: Number(r.on_hand) || 0,
      })) as BranchScopedProduct[];
      return rows;
    },
    enabled: !!orgId && !!businessId,
    staleTime: 15_000,
  });

  return {
    products: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    branchScopeLabel:
      query.data?.[0]?.branch_scope_label ??
      (branchId ? currentBranch?.name ?? "Branch" : "All branches"),
    refetch: query.refetch,
  };
}
