import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface POSReturnableQtyRow {
  original_item_id: string;
  original_transaction_id: string;
  product_id: string | null;
  description: string | null;
  unit_price: number;
  tax_rate: number;
  cost_price: number | null;
  sold_qty: number;
  returned_qty: number;
  returnable_qty: number;
}

/**
 * Stage K1 — server-truth for "how many of each line are still returnable".
 * Reads `v_pos_returnable_qty`, which subtracts already-completed returns
 * from the originally sold quantity. The Return dialog uses this to:
 *   - cap per-line +/- buttons at returnable_qty (instead of sold_qty)
 *   - hide lines that are already fully returned
 *
 * The DB RPC `process_pos_return` re-checks the same view, so this hook is
 * a UX convenience, not a security boundary.
 */
export function usePOSReturnableQty(transactionId: string | null | undefined) {
  return useQuery({
    queryKey: ["pos-returnable-qty", transactionId],
    enabled: !!transactionId,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase
        .from("v_pos_returnable_qty" as any)
        .select("original_item_id, returnable_qty")
        .eq("original_transaction_id", transactionId!);
      if (error) throw error;
      const map: Record<string, number> = {};
      (data ?? []).forEach((row: any) => {
        map[row.original_item_id] = Number(row.returnable_qty) || 0;
      });
      return map;
    },
  });
}
