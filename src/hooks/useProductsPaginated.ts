import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { usePaginatedQuery } from "./usePaginatedQuery";
import type { Product } from "./useProducts";
import { PRODUCT_BASE_UOM_SELECT } from "@/lib/inventory/uom";

export interface ProductFilters {
  search?: string;
  type?: string;
  category_id?: string;
  /**
   * Include `is_variant_parent = true` rows. Defaults to `false`.
   * See ADR 0072 / `useProducts` for rationale.
   */
  includeVariantParents?: boolean;
}

export function useProductsPaginated(filters?: ProductFilters) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;

  const businessId = currentBusiness?.id;

  const {
    data: products,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    nextPage,
    previousPage,
    refetch,
  } = usePaginatedQuery<Product>({
    queryKey: ["products-paginated", organizationId, businessId, filters],
    queryFn: async ({ from, to }) => {
      if (!organizationId || !businessId) return { data: [], count: 0 };

      let query = supabase
        .from("products")
        // Base UoM must ride along — quantity cells render "(no UoM)" without it.
        .select(`*, ${PRODUCT_BASE_UOM_SELECT}`, { count: "exact" })
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("name");

      // Apply filters server-side
      if (filters?.type && filters.type !== "all") {
        query = query.eq("type", filters.type as "product" | "service");
      }

      if (filters?.category_id && filters.category_id !== "all") {
        query = query.eq("category_id", filters.category_id);
      }

      if (filters?.search) {
        query = query.or(
          `name.ilike.%${filters.search}%,sku.ilike.%${filters.search}%`
        );
      }

      if (!filters?.includeVariantParents) {
        query = query.or(
          "is_variant_parent.is.null,is_variant_parent.eq.false",
        );
      }

      // Apply pagination range
      query = query.range(from, to);

      const { data, error, count } = await query;

      if (error) throw error;

      return {
        data: (data as Product[]) || [],
        count: count || 0,
      };
    },
    enabled: !!organizationId && !!businessId,
    pageSize: 50,
  });

  // Realtime is handled centrally by useProductRealtimeSync (mounted in
  // RealtimeSyncProvider). The previous local subscription here was a
  // duplicate, used org-only scoping (cross-company leak risk), and missed
  // INSERT/DELETE events — removing it eliminates double-invocation and
  // guarantees a single, business-scoped channel per tab.

  const createProduct = async (
    product: Pick<Product, "name"> &
      Partial<
        Omit<Product, "id" | "organization_id" | "created_at" | "updated_at" | "name">
      >
  ) => {
    if (!currentOrg) throw new Error("No organization selected");

    const { data, error } = await supabase
      .from("products")
      .insert({
        ...product,
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
      })
      .select()
      .single();

    if (error) throw error;

    // Log creation
    logAction({
      action: "created",
      entityType: "product",
      entityId: data.id,
      entityName: product.name,
      changesSummary: `Created ${product.type || "product"}: ${product.name}`,
    });

    // Refetch product list and invalidate every stock-derived cache so the
    // newly-added product's on-hand cell renders correctly without a hard
    // refresh. Realtime INSERT will also fire, but explicit invalidation
    // closes the race window between insert -> opening-balance adjustment.
    refetch();
    queryClient.invalidateQueries({ queryKey: ["products-list-stock"] });
    queryClient.invalidateQueries({ queryKey: ["warehouse-stock-totals"] });
    queryClient.invalidateQueries({ queryKey: ["low-stock-products"] });
    queryClient.invalidateQueries({ queryKey: ["stock-levels-paginated"] });
    return data;
  };

  const updateProduct = async (id: string, updates: Partial<Product>) => {
    // Strip base_uom_id from the PATCH when it matches the persisted value;
    // this both reduces noise and avoids tripping the enforce_base_uom_immutable
    // trigger on no-op edits to other columns.
    const current = products.find((p) => p.id === id) as any;
    const payload: any = { ...updates };
    if (
      current &&
      "base_uom_id" in payload &&
      payload.base_uom_id === current.base_uom_id
    ) {
      delete payload.base_uom_id;
    }

    const { error } = await supabase
      .from("products")
      .update(payload)
      .eq("id", id);

    if (error) {
      // Map the structured DB errors to actionable messages instead of the
      // generic "SOME OF THE INFORMATION YOU ENTERED IS NOT VALID" toast.
      const msg = String(error.message || "");
      if (msg.startsWith("BASE_UOM_LOCKED")) {
        const e = new Error(
          "Inventory unit is locked because this product already has stock movements or appears on transactional documents. Use Packaging to buy or sell in a different unit.",
        );
        (e as any).code = "BASE_UOM_LOCKED";
        throw e;
      }
      if (msg.startsWith("BASE_UOM_CATEGORY_CHANGE")) {
        const e = new Error(
          "The new inventory unit must belong to the same unit category as the current one (e.g. KG ↔ G, not KG ↔ PCE).",
        );
        (e as any).code = "BASE_UOM_CATEGORY_CHANGE";
        throw e;
      }
      if (
        msg.includes("sales_uom_id category") ||
        msg.includes("purchase_uom_id category")
      ) {
        const e = new Error(
          "Sales / Purchase unit must share a category with the Inventory unit. Open the Advanced panel and pick a unit from the same category, or clear it to inherit the inventory unit.",
        );
        (e as any).code = "UOM_CATEGORY_MISMATCH";
        throw e;
      }
      throw error;
    }

    // Log update
    if (current) {
      logAction({
        action: "updated",
        entityType: "product",
        entityId: id,
        entityName: current.name,
        changesSummary: `Updated product: ${current.name}`,
      });
    }

    refetch();
  };

  const deleteProduct = async (id: string) => {
    const product = products.find((p) => p.id === id);

    const { error } = await supabase.from("products").delete().eq("id", id);
    if (error) throw error;

    // Log deletion
    if (product) {
      logAction({
        action: "deleted",
        entityType: "product",
        entityId: id,
        entityName: product.name,
        changesSummary: `Deleted product: ${product.name}`,
      });
    }

    refetch();
  };

  return {
    products,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    nextPage,
    previousPage,
    createProduct,
    updateProduct,
    deleteProduct,
    refreshProducts: refetch,
  };
}
