import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useState, useMemo } from "react";
import { useDebouncedValue } from "@/hooks/useDebouncedCallback";

export interface POSProduct {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  selling_price: number;
  cost_price: number | null;
  tax_rate: number | null;
  stock_quantity: number | null;
  category: string | null;
  image_url: string | null;
  is_active: boolean;
  track_inventory: boolean;
  reorder_level: number | null;
  tax_rate_id: string | null;
  tax_rate_name: string | null;
  etims_tax_code: string | null;
  base_uom_id: string | null;
}
export interface RegisterProductScope {
  product_scope?: "all" | "by_category" | "specific";
  product_scope_categories?: string[];
  product_scope_ids?: string[];
}

const PAGE_SIZE = 200;

export function usePOSProducts(registerScope?: RegisterProductScope) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const branchId = currentBranch?.id ?? null;

  // Branch stock map is a small payload (id + qty) so it's fetched once per
  // context and reused across all product pages.
  const stockCacheKey = ["pos-products-stock", currentOrg?.id, currentBusiness?.id, branchId] as const;

  type Page = { rows: POSProduct[]; nextOffset: number; totalCount: number | null };

  const {
    data,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<Page>({
    queryKey: ["pos-products", currentOrg?.id, currentBusiness?.id, branchId, debouncedSearch],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.rows.length === PAGE_SIZE ? lastPage.nextOffset : undefined,
    queryFn: async ({ pageParam }) => {
      const offset = pageParam as number;

      // Fetch branch stock once, cache across pages.
      let stockMap = queryClient.getQueryData<Map<string, number>>(stockCacheKey as any);
      if (!stockMap) {
        const { data: scoped, error: scopedErr } = await supabase.rpc(
          "list_products_with_branch_stock" as any,
          {
            p_org_id: currentOrg!.id,
            p_business_id: currentBusiness!.id,
            p_branch_id: branchId,
            p_include_variant_parents: false,
          } as any,
        );
        if (scopedErr) throw scopedErr;
        stockMap = new Map<string, number>();
        ((scoped as any[]) || []).forEach((r) => {
          stockMap!.set(r.id, Number(r.available ?? r.on_hand) || 0);
        });
        queryClient.setQueryData(stockCacheKey as any, stockMap);
      }

      let query = supabase
        .from("products")
        .select(
          `*,
          tax_rate_ref:tax_rates(id, name, rate, etims_tax_code),
          product_category:product_categories(id, name)`,
          { count: "exact" },
        )
        .eq("organization_id", currentOrg!.id)
        .eq("status", "active")
        .eq("business_id", currentBusiness!.id)
        .or("is_variant_parent.is.null,is_variant_parent.eq.false");

      if (debouncedSearch) {
        const q = `%${debouncedSearch}%`;
        query = query.or(`name.ilike.${q},sku.ilike.${q},description.ilike.${q}`);
      }

      const { data: rows, error, count } = await query
        .order("name")
        .order("id")
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) throw error;

      const mapped = (rows || []).map((p: any) => {
        const taxRef = p.tax_rate_ref as
          | { id: string; name: string; rate: number; etims_tax_code: string | null }
          | null;
        const categoryRef = p.product_category as { id: string; name: string } | null;
        const branchStock = stockMap!.has(p.id) ? stockMap!.get(p.id)! : 0;
        return {
          id: p.id,
          name: p.name,
          sku: p.sku,
          description: p.description,
          selling_price: p.unit_price || 0,
          cost_price: p.cost_price,
          tax_rate: taxRef?.rate ?? p.tax_rate,
          stock_quantity: branchStock,
          category: categoryRef?.name || p.type,
          image_url: p.image_url,
          is_active: p.is_active,
          track_inventory: p.track_inventory,
          reorder_level: p.reorder_level,
          tax_rate_id: taxRef?.id ?? p.tax_rate_id,
          tax_rate_name: taxRef?.name ?? null,
          etims_tax_code: taxRef?.etims_tax_code ?? null,
          base_uom_id: p.base_uom_id ?? null,
        } as POSProduct;
      });

      return { rows: mapped, nextOffset: offset + PAGE_SIZE, totalCount: count ?? null };
    },
  });

  const products = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p.rows),
    [data],
  );
  const totalCount = data?.pages?.[0]?.totalCount ?? null;

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
    return result;
  }, [products, selectedCategory, registerScope]);

  /**
   * Local-only barcode/SKU lookup. Authoritative scan resolution lives in
   * useResolveBarcode (server RPC); this helper is kept for the in-grid
   * search-Enter fast path against already-loaded rows.
   */
  const findByBarcode = (barcode: string) => {
    return products.find((p) => p.sku?.toLowerCase() === barcode.toLowerCase());
  };

  const hasStock = (productId: string, quantity: number = 1) => {
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
    hasStock,
    // pagination
    totalCount,
    loadedCount: products.length,
    hasMore: !!hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  };
}
