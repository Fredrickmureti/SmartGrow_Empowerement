import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

/**
 * Subscribes to real-time changes on stock_movements, stock_adjustments,
 * warehouse_stock, and products. Auto-invalidates relevant TanStack Query caches.
 *
 * F6 (audit): channel is now narrowed by both organization_id AND business_id
 * so cross-company tabs in the same workspace don't thrash each other's caches.
 */
export function useInventoryRealtime() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  useEffect(() => {
    if (!orgId || !businessId) return;

    // Helper: invalidate but ONLY refetch queries with active observers
    // (i.e. queries whose page is currently mounted). Unmounted pages keep
    // their cached data marked stale; they refetch only when re-visited.
    // This is the cost-control invariant: inventory events do NOT cause
    // database fetches on the Purchases / Sales / HR / etc. pages while
    // the user is sitting elsewhere.
    const inv = (key: readonly unknown[]) =>
      queryClient.invalidateQueries({ queryKey: key as unknown[], refetchType: "active" });

    const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase
      .channel(`inventory-realtime-${orgId}-${businessId}-${uid}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "stock_movements", filter: `business_id=eq.${businessId}` },
        () => {
          inv(["stock-movements"]);
          inv(["stock-movements-paginated"]);
          inv(["product-movements-drawer"]);
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "stock_adjustments", filter: `business_id=eq.${businessId}` },
        () => {
          inv(["stock-adjustments"]);
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "warehouse_stock", filter: `business_id=eq.${businessId}` },
        () => {
          inv(["stock-levels-paginated"]);
          inv(["reserved-qty"]);
          inv(["warehouse-stock-detail"]);
          inv(["product-warehouse-stock"]);
          inv(["low-stock-products"]);
          inv(["products-list-stock"]);
          inv(["warehouse-stock-totals"]);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "products",
          // Phase A audit fix: scope by business_id, not organization_id.
          filter: `business_id=eq.${businessId}`,
        },
        () => {
          inv(["products"]);
          inv(["product-drawer"]);
          inv(["low-stock-products"]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [orgId, businessId, queryClient]);
}
