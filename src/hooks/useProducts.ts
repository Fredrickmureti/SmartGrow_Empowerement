import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { usePermissions } from "./usePermissions";
import { triggerAutomation, getChangedFields } from "@/lib/automations/triggerAutomation";
import { normalizeError } from "@/services/resilience";
import { PRODUCT_BASE_UOM_SELECT } from "@/lib/inventory/uom";

export interface Product {
  id: string;
  organization_id: string;
  business_id?: string | null;
  type: "product" | "service";
  name: string;
  description: string | null;
  sku: string | null;
  unit_price: number;
  cost_price: number | null;
  tax_rate: number | null;
  is_active: boolean;
  image_url: string | null;
  created_at: string;
  updated_at: string;
  // MOQ fields
  min_order_quantity: number | null;
  order_quantity_increment: number | null;
  // Stock fields
  stock_quantity?: number | null;
  reorder_level?: number | null;
  track_inventory?: boolean;
  // Category
  category_id?: string | null;
  // Default GL account mappings
  sales_account_id?: string | null;
  purchase_account_id?: string | null;
  cogs_account_id?: string | null;
  inventory_account_id?: string | null;
}

export interface UseProductsOptions {
  /**
   * Include `is_variant_parent = true` rows. Defaults to `false` because
   * variant parents are catalogue-only aggregates and must never appear in
   * transactional pickers, valuation reports, or picklists (ADR 0072). Admin
   * surfaces (product list, product form) opt back in explicitly.
   */
  includeVariantParents?: boolean;
}

export function useProducts(options: UseProductsOptions = {}) {
  const { includeVariantParents = false } = options;
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { can } = usePermissions();
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchProducts = useCallback(async () => {
    if (!currentOrg || !currentBusiness) return;

    setIsLoading(true);
    try {
      let query = supabase
        .from("products")
        // canonical unit label source; `unit_of_measure` is not a column
        .select(`*, ${PRODUCT_BASE_UOM_SELECT}`)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("name");

      if (!includeVariantParents) {
        // Variant parents are un-transactable (ADR 0072). Legacy rows may
        // have NULL for the flag, so treat NULL as false.
        query = query.or("is_variant_parent.is.null,is_variant_parent.eq.false");
      }

      const { data, error } = await query;

      if (error) throw error;
      setProducts(data as Product[]);
    } catch (error: any) {
      console.error("Error fetching products:", error);
      toast({
        title: "Error loading products",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg, currentBusiness, toast, includeVariantParents]);

  // Initial fetch
  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // Real-time updates are handled centrally by useProductRealtimeSync in RealtimeSyncProvider.
  // Do NOT add a local subscription here — it causes channel name collisions and triple-subscription waste.

  const createProduct = async (product: Pick<Product, "name"> & Partial<Omit<Product, "id" | "organization_id" | "created_at" | "updated_at" | "name">>) => {
    if (!can("manageProducts")) { toast({ title: "Permission denied", description: "You don't have permission to create products", variant: "destructive" }); throw new Error("Permission denied"); }
    if (!currentOrg || !currentBusiness) throw new Error("No business selected");

    const { data, error } = await supabase
      .from("products")
      .insert({
        ...product,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
      })
      .select()
      .single();

    if (error) throw error;

    logAction({
      action: "created",
      entityType: "product",
      entityId: data.id,
      entityName: product.name,
      changesSummary: `Created ${product.type || "product"}: ${product.name}`,
    });

    // Real-time subscription will add the product to state
    // No need to fetchProducts() - the INSERT event will trigger the update

    // Trigger automations (fire-and-forget)
    if (currentOrg) {
      triggerAutomation({
        event_type: "on_create",
        target_model: "product",
        record_id: data.id,
        record_data: data as unknown as Record<string, unknown>,
        organization_id: currentOrg.id,
      });
    }

    return data;
  };

  const updateProduct = async (id: string, updates: Partial<Product>) => {
    if (!can("manageProducts")) { toast({ title: "Permission denied", description: "You don't have permission to update products", variant: "destructive" }); throw new Error("Permission denied"); }
    const previousProducts = [...products];
    const product = products.find((p) => p.id === id) as any;

    // Mirror useProductsPaginated.updateProduct: strip a no-op
    // `base_uom_id` from the PATCH so unrelated edits don't trip the
    // `enforce_base_uom_immutable` trigger (ADR 0035) on transacted
    // products.
    const payload: any = { ...updates };
    if (
      product &&
      "base_uom_id" in payload &&
      payload.base_uom_id === product.base_uom_id
    ) {
      delete payload.base_uom_id;
    }

    // Optimistic update: update UI immediately
    setProducts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates } : p))
    );

    try {
      const { error } = await supabase
        .from("products")
        .update(payload)
        .eq("id", id);

      if (error) {
        // Translate structured DB errors raised by
        // `enforce_base_uom_immutable` / `enforce_product_uom_category`
        // into actionable messages instead of the generic 400 toast.
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

      // Log the action
      if (product) {
        logAction({
          action: "updated",
          entityType: "product",
          entityId: id,
          entityName: product.name,
          changesSummary: `Updated product: ${product.name}`,
        });
      }

      // Real-time subscription will handle the final sync
      // No need to fetchProducts() - this was causing the delay!

      // Trigger automations (fire-and-forget)
      if (currentOrg && product) {
        const changedFields = getChangedFields(product as unknown as Record<string, unknown>, updates as Record<string, unknown>);
        triggerAutomation({
          event_type: changedFields.length > 0 ? "field_change" : "on_update",
          target_model: "product",
          record_id: id,
          record_data: { ...product, ...updates } as unknown as Record<string, unknown>,
          old_data: product as unknown as Record<string, unknown>,
          changed_fields: changedFields,
          organization_id: currentOrg.id,
        });
      }
    } catch (error) {
      // Rollback on error (including the mapped BASE_UOM_* errors above)
      console.error("Failed to update product, rolling back:", error);
      setProducts(previousProducts);
      throw error;
    }
  };

  const deleteProduct = async (id: string) => {
    if (!can("manageProducts")) { toast({ title: "Permission denied", description: "You don't have permission to delete products", variant: "destructive" }); throw new Error("Permission denied"); }
    const product = products.find((p) => p.id === id);
    const previousProducts = [...products];
    
    // Optimistic update: remove from UI immediately
    setProducts((prev) => prev.filter((p) => p.id !== id));

    try {
      const { error } = await supabase.from("products").delete().eq("id", id);
      if (error) throw error;

      if (product) {
        logAction({
          action: "deleted",
          entityType: "product",
          entityId: id,
          entityName: product.name,
          changesSummary: `Deleted product: ${product.name}`,
        });
      }
      
      // Real-time subscription confirms the deletion
      // No need to fetchProducts()

      // Trigger automations (fire-and-forget)
      if (currentOrg && product) {
        triggerAutomation({
          event_type: "on_delete",
          target_model: "product",
          record_id: id,
          record_data: product as unknown as Record<string, unknown>,
          organization_id: currentOrg.id,
        });
      }
    } catch (error) {
      // Rollback on error
      console.error("Failed to delete product, rolling back:", error);
      setProducts(previousProducts);
      throw error;
    }
  };

  return {
    products,
    isLoading,
    createProduct,
    updateProduct,
    deleteProduct,
    refreshProducts: fetchProducts,
  };
}
