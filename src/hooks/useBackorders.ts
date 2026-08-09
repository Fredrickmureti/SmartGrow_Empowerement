import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

/**
 * Phase 5 — one backorder engine.
 *
 * A backorder is NOT a separate record any more: it is the open-to-deliver
 * quantity on a live sales order line, read from the `so_backorder_lines`
 * view (which is derived from `so_line_balances`). The physical follow-on
 * delivery note created by `record_partial_delivery_atomic` remains the only
 * mechanism that moves goods.
 *
 * The legacy `backorders` table is read-only for app users; nothing here
 * writes quantities. Never re-sum SO / DN lines locally.
 */
export interface BackorderLine {
  sales_order_item_id: string;
  sales_order_id: string;
  so_number: string;
  order_status: string;
  order_date: string | null;
  contact_id: string | null;
  product_id: string;
  description: string | null;
  quantity_ordered: number;
  quantity_delivered: number;
  quantity_on_open_deliveries: number;
  quantity_backordered: number;
  sales_order?: { so_number: string; contact?: { name: string } | null } | null;
  product?: { name: string; sku: string | null } | null;
}

export function useBackorders() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [backorders, setBackorders] = useState<BackorderLine[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchBackorders = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      let query = supabase
        .from("so_backorder_lines" as any)
        .select(`
          *,
          sales_order:sales_orders(so_number, contact:contacts!sales_orders_contact_id_fkey(name)),
          product:products(name, sku)
        `)
        .eq("organization_id", currentOrg.id);

      if (currentBusiness) {
        query = query.eq("business_id", currentBusiness.id);
      }

      const { data, error } = await query.order("order_date", { ascending: true });

      if (error) throw error;
      setBackorders((data || []) as unknown as BackorderLine[]);
    } catch (error) {
      console.error("Error fetching backorders:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    if (currentOrg) void fetchBackorders();
  }, [fetchBackorders, currentOrg?.id]);

  /** Open demand queue for one product, oldest order first. */
  const getBackorderQueue = async (productId: string): Promise<BackorderLine[]> => {
    if (!currentOrg) return [];

    let query = supabase
      .from("so_backorder_lines" as any)
      .select(`*, sales_order:sales_orders(so_number, contact:contacts!sales_orders_contact_id_fkey(name))`)
      .eq("organization_id", currentOrg.id)
      .eq("product_id", productId);

    if (currentBusiness) query = query.eq("business_id", currentBusiness.id);

    const { data, error } = await query.order("order_date", { ascending: true });
    if (error) return [];
    return (data || []) as unknown as BackorderLine[];
  };

  return {
    backorders,
    isLoading,
    refresh: fetchBackorders,
    getBackorderQueue,
  };
}
