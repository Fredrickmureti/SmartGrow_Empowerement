import { useEffect, useRef, useContext } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { BusinessContext } from "@/contexts/BusinessContext";

/**
 * useProductIdentifiersRealtimeSync — Stage 4 of the POS scanner re-audit.
 *
 * Subscribes to `public.product_identifiers` postgres_changes filtered by
 * the active business. Any INSERT/UPDATE/DELETE invalidates the
 * `product-identifiers` query key, which in turn busts the in-process LRU
 * inside `useResolveBarcode` via its query-cache subscriber.
 *
 * Without this hook, a barcode added on the Products page only becomes
 * scannable in POS after some unrelated `pos-products` invalidation
 * happens to clear the resolver cache.
 *
 * Mount ONCE at the app root (RealtimeSyncProvider) — it's a single
 * long-lived WebSocket, not a per-page subscription.
 */
export function useProductIdentifiersRealtimeSync() {
  const queryClient = useQueryClient();
  const { currentOrg } = useOrganization();
  const businessCtx = useContext(BusinessContext);
  const currentBusiness = businessCtx?.currentBusiness ?? null;
  const subscriptionRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    if (!currentOrg?.id || !currentBusiness?.id) return;

    if (subscriptionRef.current) {
      supabase.removeChannel(subscriptionRef.current);
    }

    const businessId = currentBusiness.id;

    const invalidate = () => {
      // Busts useResolveBarcode's LRU (it listens for this key) AND
      // refreshes any per-product identifiers editor across tabs.
      queryClient.invalidateQueries({
        queryKey: ["product-identifiers"],
        refetchType: "active",
      });
    };

    const channel = supabase
      .channel(`product-identifiers-realtime-${currentOrg.id}-${businessId}`)
      .on(
        "postgres_changes" as never,
        {
          event: "INSERT",
          schema: "public",
          table: "product_identifiers",
          filter: `business_id=eq.${businessId}`,
        } as never,
        invalidate,
      )
      .on(
        "postgres_changes" as never,
        {
          event: "UPDATE",
          schema: "public",
          table: "product_identifiers",
          filter: `business_id=eq.${businessId}`,
        } as never,
        invalidate,
      )
      .on(
        "postgres_changes" as never,
        {
          event: "DELETE",
          schema: "public",
          table: "product_identifiers",
          filter: `business_id=eq.${businessId}`,
        } as never,
        invalidate,
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "CLOSED") {
          console.error("[Realtime] product_identifiers subscription failed:", status);
        } else if (status === "SUBSCRIBED") {
          console.debug("[Realtime] product_identifiers subscription active");
        }
      });

    subscriptionRef.current = channel;

    return () => {
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
        subscriptionRef.current = null;
      }
    };
  }, [currentOrg?.id, currentBusiness?.id, queryClient]);

  return null;
}
