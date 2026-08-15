import { useEffect, useState, useCallback, useRef, useContext } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BusinessContext } from "@/contexts/BusinessContext";
import { useQueryClient } from "@tanstack/react-query";

interface StockUpdate {
  product_id: string;
  timestamp: string;
}

interface StockReservation {
  productId: string;
  quantity: number;
  reservedAt: string;
  expiresAt: string;
}

const RESERVATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * POS stock synchronisation.
 *
 * Phase 3 (availability): the browser is never authoritative for stock.
 *   - The realtime signal is the branch-grained `stock_quants` table, NOT the
 *     company-wide `products.stock_quantity` cache. The old subscription
 *     fired on a cached aggregate that mixes every branch together, so
 *     Branch A saw "out of stock" toasts for Branch B's movements.
 *   - The signal is used ONLY to invalidate caches. No quantity that arrives
 *     over the wire is ever used as a checkout decision input; every decision
 *     re-asks the server through the register-scoped availability RPCs.
 */
export function usePOSStockSync() {
  const businessCtx = useContext(BusinessContext);
  const businessId = businessCtx?.currentBusiness?.id ?? null;
  const queryClient = useQueryClient();
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [recentUpdates, setRecentUpdates] = useState<StockUpdate[]>([]);
  const reservationsRef = useRef<Map<string, StockReservation>>(new Map());

  // Subscribe to branch-grained stock changes for this business.
  useEffect(() => {
    if (!businessId) return;

    const channel = supabase
      .channel(`pos-stock-quants-${businessId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "stock_quants",
          filter: `business_id=eq.${businessId}`,
        },
        (payload) => {
          const row = (payload.new ?? payload.old) as { product_id?: string } | null;
          const productId = row?.product_id;
          if (!productId) return;

          setRecentUpdates((prev) => [
            { product_id: productId, timestamp: new Date().toISOString() },
            ...prev.slice(0, 19),
          ]);

          // Cache invalidation only — availability is re-read from the server.
          queryClient.invalidateQueries({ queryKey: ["pos-products"] });
          queryClient.invalidateQueries({ queryKey: ["products"] });
        }
      )
      .subscribe((status) => {
        setIsSubscribed(status === "SUBSCRIBED");
      });

    return () => {
      supabase.removeChannel(channel);
      setIsSubscribed(false);
    };
  }, [businessId, queryClient]);

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
   *
   * One round trip for the whole cart via
   * `get_available_pos_stock_for_register_batch`, so the availability snapshot
   * is consistent across lines instead of drifting between N sequential calls.
   */
  const verifyCartStock = useCallback(
    async (
      registerId: string,
      items: Array<{ product_id: string; quantity: number; name: string }>
    ): Promise<{ valid: boolean; outOfStock: string[] }> => {
      if (items.length === 0) return { valid: true, outOfStock: [] };

      // Same product can appear on several lines — the cart needs the sum.
      const required = new Map<string, number>();
      for (const item of items) {
        required.set(item.product_id, (required.get(item.product_id) ?? 0) + item.quantity);
      }

      const { data, error } = await supabase.rpc(
        "get_available_pos_stock_for_register_batch" as any,
        {
          p_product_ids: Array.from(required.keys()),
          p_register_id: registerId,
          p_exclude_self: true,
        }
      );

      // Fail closed: an unreachable authority must never green-light a sale.
      if (error) {
        return { valid: false, outOfStock: Array.from(new Set(items.map((i) => i.name))) };
      }

      const availability = new Map<string, number>(
        ((data ?? []) as Array<{ product_id: string; available: number | string }>).map((r) => [
          r.product_id,
          Number(r.available ?? 0),
        ])
      );

      const shortIds = new Set<string>();
      required.forEach((qty, productId) => {
        if ((availability.get(productId) ?? 0) < qty) shortIds.add(productId);
      });

      const outOfStock = Array.from(
        new Set(items.filter((i) => shortIds.has(i.product_id)).map((i) => i.name))
      );

      return { valid: outOfStock.length === 0, outOfStock };
    },
    []
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
