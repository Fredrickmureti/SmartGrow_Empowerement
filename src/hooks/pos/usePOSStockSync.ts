import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface StockUpdate {
  product_id: string;
  product_name: string;
  old_quantity: number;
  new_quantity: number;
  timestamp: string;
}

interface StockReservation {
  productId: string;
  quantity: number;
  reservedAt: string;
  expiresAt: string;
}

const RESERVATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function usePOSStockSync() {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [recentUpdates, setRecentUpdates] = useState<StockUpdate[]>([]);
  const reservationsRef = useRef<Map<string, StockReservation>>(new Map());

  // Subscribe to real-time product stock changes
  useEffect(() => {
    if (!currentOrg?.id) return;

    const channel = supabase
      .channel(`stock-updates-${currentOrg.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "products",
          filter: `organization_id=eq.${currentOrg.id}`,
        },
        (payload) => {
          const oldStock = (payload.old as { stock_quantity?: number })?.stock_quantity ?? 0;
          const newStock = (payload.new as { stock_quantity?: number; id: string; name: string })?.stock_quantity ?? 0;
          const productId = (payload.new as { id: string }).id;
          const productName = (payload.new as { name: string }).name;

          // Only notify if stock actually changed
          if (oldStock !== newStock) {
            const update: StockUpdate = {
              product_id: productId,
              product_name: productName,
              old_quantity: oldStock,
              new_quantity: newStock,
              timestamp: new Date().toISOString(),
            };

            setRecentUpdates((prev) => [update, ...prev.slice(0, 19)]);

            // Invalidate product queries to refresh data
            queryClient.invalidateQueries({ queryKey: ["pos-products"] });
            queryClient.invalidateQueries({ queryKey: ["products"] });

            // Show low stock warning
            if (newStock <= 5 && newStock > 0) {
              toast.warning(`Low stock: ${productName} (${newStock} left)`);
            } else if (newStock <= 0) {
              toast.error(`Out of stock: ${productName}`);
            }
          }
        }
      )
      .subscribe((status) => {
        setIsSubscribed(status === "SUBSCRIBED");
      });

    return () => {
      supabase.removeChannel(channel);
      setIsSubscribed(false);
    };
  }, [currentOrg?.id, queryClient]);

  /**
   * Reserve stock for items in cart (optimistic locking)
   */
  const reserveStock = useCallback(
    (productId: string, quantity: number): boolean => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + RESERVATION_TIMEOUT_MS);

      // Check if already reserved
      const existing = reservationsRef.current.get(productId);
      if (existing) {
        // Update existing reservation
        existing.quantity = quantity;
        existing.expiresAt = expiresAt.toISOString();
        return true;
      }

      // Create new reservation
      reservationsRef.current.set(productId, {
        productId,
        quantity,
        reservedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });

      return true;
    },
    []
  );

  /**
   * Release stock reservation
   */
  const releaseReservation = useCallback((productId: string): void => {
    reservationsRef.current.delete(productId);
  }, []);

  /**
   * Release all reservations (e.g., when transaction completes or is cancelled)
   */
  const releaseAllReservations = useCallback((): void => {
    reservationsRef.current.clear();
  }, []);

  /**
   * Get current reservations
   */
  const getReservations = useCallback((): StockReservation[] => {
    const now = new Date().toISOString();
    const active: StockReservation[] = [];

    reservationsRef.current.forEach((reservation, productId) => {
      if (reservation.expiresAt > now) {
        active.push(reservation);
      } else {
        // Clean up expired reservations
        reservationsRef.current.delete(productId);
      }
    });

    return active;
  }, []);

  /**
   * Check if product has sufficient stock for a given POS register.
   *
   * Stage 2 (zero-trust audit): MUST go through the branch-aware RPC
   * `get_available_pos_stock_for_register`. Reading `products.stock_quantity`
   * is forbidden as a decision input — it is a company-wide cached aggregate
   * and would let Branch A check out against Branch B's stock.
   */
  const checkAvailability = useCallback(
    async (productId: string, registerId: string, requestedQuantity: number): Promise<boolean> => {
      const { data, error } = await supabase.rpc(
        "get_available_pos_stock_for_register" as any,
        {
          p_product_id: productId,
          p_register_id: registerId,
          p_exclude_self: true,
        }
      );
      if (error) return false;
      const available = Number(data ?? 0);
      return available >= requestedQuantity;
    },
    []
  );

  /**
   * Verify all cart items have sufficient stock before checkout (per register/branch).
   */
  const verifyCartStock = useCallback(
    async (
      registerId: string,
      items: Array<{ product_id: string; quantity: number; name: string }>
    ): Promise<{ valid: boolean; outOfStock: string[] }> => {
      const outOfStock: string[] = [];

      for (const item of items) {
        const ok = await checkAvailability(item.product_id, registerId, item.quantity);
        if (!ok) {
          outOfStock.push(item.name);
        }
      }

      return {
        valid: outOfStock.length === 0,
        outOfStock,
      };
    },
    [checkAvailability]
  );

  /**
   * Clear old updates
   */
  const clearRecentUpdates = useCallback(() => {
    setRecentUpdates([]);
  }, []);

  return {
    isSubscribed,
    recentUpdates,
    reserveStock,
    releaseReservation,
    releaseAllReservations,
    getReservations,
    checkAvailability,
    verifyCartStock,
    clearRecentUpdates,
  };
}
