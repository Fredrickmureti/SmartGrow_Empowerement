/**
 * Server-Side Stock Reservation Hook
 * Uses DB-level reserve_stock/release_stock RPCs for atomic cross-terminal safety
 */

import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

export function usePOSStockReservation(registerId?: string) {
  const { currentOrg } = useOrganization();

  // Reserve stock for a product at a specific warehouse
  const reserveStock = useMutation({
    mutationFn: async (input: {
      productId: string;
      warehouseId: string;
      quantity: number;
    }) => {
      if (!currentOrg?.id) throw new Error("Missing organization");

      // Pre-flight branch alignment check.
      // Per ARCHITECTURE.md, a POS register lives in exactly one branch and
      // stock_movements.branch_id must match the register's branch (enforced
      // by a 2026-04-22 trigger). We refuse the reservation here too, so a
      // wrong-branch warehouse cannot place a phantom hold on another
      // branch's stock before the trigger rejects the downstream movement.
      if (registerId) {
        const [{ data: reg, error: regErr }, { data: wh, error: whErr }] = await Promise.all([
          supabase
            .from("pos_registers")
            .select("branch_id, business_id")
            .eq("id", registerId)
            .single(),
          supabase
            .from("warehouses")
            .select("branch_id, business_id")
            .eq("id", input.warehouseId)
            .single(),
        ]);
        if (regErr) throw regErr;
        if (whErr) throw whErr;
        if (wh.business_id && reg.business_id && wh.business_id !== reg.business_id) {
          throw new Error("This warehouse belongs to a different company than the POS register");
        }
        if (wh.branch_id && wh.branch_id !== reg.branch_id) {
          throw new Error("This warehouse belongs to a different branch than the POS register");
        }
      }

      const { data, error } = await supabase.rpc("reserve_stock" as any, {
        p_organization_id: currentOrg.id,
        p_product_id: input.productId,
        p_warehouse_id: input.warehouseId,
        p_quantity: input.quantity,
        p_reference_type: "pos_register",
        p_reference_id: registerId || null,
      });

      if (error) throw error;
      const result = data as any;
      if (!result?.success) {
        throw new Error(result?.error || `Only ${result?.available} available`);
      }
      return result;
    },
  });

  // Release reserved stock
  const releaseStock = useMutation({
    mutationFn: async (input: {
      productId: string;
      warehouseId: string;
      quantity: number;
    }) => {
      if (!currentOrg?.id) throw new Error("Missing organization");

      const { data, error } = await supabase.rpc("release_stock" as any, {
        p_organization_id: currentOrg.id,
        p_product_id: input.productId,
        p_warehouse_id: input.warehouseId,
        p_quantity: input.quantity,
      });

      if (error) throw error;
      const result = data as any;
      // Phase 1.4: release_stock now returns success=false on under-release
      // (reservation drift) instead of silently releasing less than asked.
      // Surface the error so the POS in-memory cache can self-heal.
      if (!result?.success) {
        throw new Error(
          result?.error ||
            `Reservation drift: only ${result?.reserved ?? 0} reserved (requested ${input.quantity})`,
        );
      }
      return result;
    },
  });

  return {
    reserveStock,
    releaseStock,
  };
}
