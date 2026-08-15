/**
 * POS product read seam (Phase 1 — canonical product consumption).
 *
 * POS reads products through ONE server seam: the canonical
 * `list_products_with_branch_stock` RPC. It returns identity, price, tax,
 * UoM, packaging levels and branch/warehouse-scoped stock in one shape.
 *
 * POS must NOT query the `products` table directly and must NOT maintain a
 * competing product representation — the grid path and the scan path
 * (`pos_resolve_scan` → `resolve_product_identity`) resolve the same
 * canonical product contract. Guarded by
 * `src/test/architecture/pos-product-read-seam.test.ts`.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useState, useMemo } from "react";
import { useDebouncedValue } from "@/hooks/useDebouncedCallback";

export interface POSPackagingLevel {
  id: string;
  name: string;
  qty_in_base_uom: number;
  is_sales_default: boolean;
  is_shipping_unit: boolean;
}

export interface POSProduct {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  selling_price: number;
  cost_price: number | null;
  tax_rate: number | null;
  stock_quantity: number | null;
  /** Category display name (for the grid filter chips). */
  category: string | null;
  /** Canonical category id (what the cart/line contract stores). */
  category_id?: string | null;
  image_url: string | null;
  is_active: boolean;
  track_inventory: boolean;
  reorder_level: number | null;
  tax_rate_id: string | null;
  tax_rate_name: string | null;
  etims_tax_code: string | null;
  base_uom_id: string | null;
  /** Canonical UoM / packaging contract (server-resolved). */
  base_uom_code?: string | null;
  base_uom_name?: string | null;
  sales_uom_id?: string | null;
  sales_uom_code?: string | null;
  sales_uom_name?: string | null;
  packaging?: POSPackagingLevel[];
  is_weighted?: boolean;
  plu_code?: string | null;
  /** Branch/warehouse-scoped availability from the canonical stock resolver. */
  on_hand?: number;
  reserved?: number;
  available?: number;
}

export interface RegisterProductScope {
  product_scope?: "all" | "by_category" | "specific";
  product_scope_categories?: string[];
  product_scope_ids?: string[];
}

/** Maps one canonical RPC row onto the POS view shape. Field renames only. */
export function mapCanonicalProductRow(r: any): POSProduct {
  return {
    id: r.id,
    name: r.name,
    sku: r.sku ?? null,
    description: r.description ?? null,
    selling_price: Number(r.unit_price) || 0,
    cost_price: r.cost_price === null || r.cost_price === undefined ? null : Number(r.cost_price),
    tax_rate: r.tax_rate === null || r.tax_rate === undefined ? null : Number(r.tax_rate),
    stock_quantity: Number(r.available ?? r.on_hand) || 0,
    category: r.category_name ?? null,
    category_id: r.category_id ?? null,
    image_url: r.image_url ?? null,
    is_active: r.is_active !== false,
    track_inventory: r.track_inventory !== false,
    reorder_level: r.reorder_level === null || r.reorder_level === undefined ? null : Number(r.reorder_level),
    tax_rate_id: r.tax_rate_id ?? null,
    tax_rate_name: r.tax_rate_name ?? null,
    etims_tax_code: r.etims_tax_code ?? null,
    base_uom_id: r.base_uom_id ?? null,
    base_uom_code: r.base_uom_code ?? null,
    base_uom_name: r.base_uom_name ?? null,
    sales_uom_id: r.sales_uom_id ?? null,
    sales_uom_code: r.sales_uom_code ?? null,
    sales_uom_name: r.sales_uom_name ?? null,
    packaging: Array.isArray(r.packaging)
      ? (r.packaging as any[]).map((p) => ({
          id: p.id,
          name: p.name,
          qty_in_base_uom: Number(p.qty_in_base_uom) || 0,
          is_sales_default: !!p.is_sales_default,
          is_shipping_unit: !!p.is_shipping_unit,
        }))
      : [],
    is_weighted: !!r.is_weighted,
    plu_code: r.plu_code ?? null,
    on_hand: Number(r.on_hand) || 0,
    reserved: Number(r.reserved) || 0,
    available: Number(r.available) || 0,
  };
}

export function usePOSProducts(registerScope?: RegisterProductScope) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const branchId = currentBranch?.id ?? null;

  const { data, isLoading } = useQuery<POSProduct[]>({
    queryKey: ["pos-products", currentOrg?.id, currentBusiness?.id, branchId],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 15_000,
    queryFn: async () => {
      const { data: rows, error } = await supabase.rpc(
        "list_products_with_branch_stock" as any,
        {
          p_org_id: currentOrg!.id,
          p_business_id: currentBusiness!.id,
          p_branch_id: branchId,
          p_include_variant_parents: false,
          p_warehouse_id: null,
        } as any,
      );
      if (error) throw error;
      return ((rows as any[]) || []).map(mapCanonicalProductRow);
    },
  });

  const products = useMemo(() => data ?? [], [data]);
  const totalCount = products.length;

  // Real-time updates are handled centrally by useProductRealtimeSync.

  const categories = useMemo(() => {
    const cats = new Set<string>();
    products.forEach((p) => {
      if (p.category) cats.add(p.category);
    });
    return Array.from(cats).sort();
  }, [products]);

  const filteredProducts = useMemo(() => {
    let result = products;
    if (registerScope?.product_scope === "by_category" && registerScope.product_scope_categories?.length) {
      result = result.filter(
        (p) => p.category && registerScope.product_scope_categories!.includes(p.category),
      );
    } else if (registerScope?.product_scope === "specific" && registerScope.product_scope_ids?.length) {
      result = result.filter((p) => registerScope.product_scope_ids!.includes(p.id));
    }
    if (selectedCategory) {
      result = result.filter((p) => p.category === selectedCategory);
    }
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.sku ?? "").toLowerCase().includes(q) ||
          (p.description ?? "").toLowerCase().includes(q),
      );
    }
    return result;
  }, [products, selectedCategory, registerScope, debouncedSearch]);

  /**
   * Local-only SKU fast path for the in-grid search box. Authoritative scan
   * resolution lives in useResolveBarcode (server RPC).
   */
  const findByBarcode = (barcode: string) => {
    return products.find((p) => p.sku?.toLowerCase() === barcode.toLowerCase());
  };

  /**
   * ADVISORY ONLY — cached grid hint for badges/greying.
   * Never a checkout decision: authority is
   * `get_available_pos_stock_for_register[_batch]` (see usePOSStockSync).
   */
  const hasStockHint = (productId: string, quantity: number = 1) => {
    const product = products.find((p) => p.id === productId);
    if (!product) return false;
    if (!product.track_inventory) return true;
    return (product.stock_quantity || 0) >= quantity;
  };

  return {
    products,
    filteredProducts,
    categories,
    isLoading,
    searchQuery,
    setSearchQuery,
    selectedCategory,
    setSelectedCategory,
    findByBarcode,
    hasStockHint,
    // pagination (the canonical seam returns the branch-scoped catalog in one
    // call; these are kept so existing consumers keep compiling)
    totalCount,
    loadedCount: products.length,
    hasMore: false,
    fetchNextPage: () => {},
    isFetchingNextPage: false,
  };
}
