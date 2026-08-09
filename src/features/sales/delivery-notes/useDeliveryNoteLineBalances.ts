import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Canonical quantity ledger for a delivery note.
 *
 * `dn_line_balances` is the single place delivered / invoiced / returned /
 * outstanding quantities are computed (it zeroes quantities for notes that
 * have not reached a goods-issue state and nets completed return DNs).
 * UI surfaces must read it instead of re-deriving quantities from
 * `delivery_note_items`, which ignores status and returns.
 */
export type DeliveryNoteLineBalance = {
  delivery_note_item_id: string;
  delivery_note_id: string;
  product_id: string | null;
  quantity_ordered: number;
  quantity_delivered: number;
  quantity_invoiced: number;
  quantity_returned: number;
  quantity_outstanding: number;
};

export function useDeliveryNoteLineBalances(deliveryNoteId: string | null | undefined) {
  return useQuery({
    queryKey: ["dn-line-balances", deliveryNoteId],
    enabled: !!deliveryNoteId,
    queryFn: async (): Promise<DeliveryNoteLineBalance[]> => {
      const { data, error } = await (supabase as any)
        .from("dn_line_balances")
        .select(
          "delivery_note_item_id, delivery_note_id, product_id, quantity_ordered, quantity_delivered, quantity_invoiced, quantity_returned, quantity_outstanding",
        )
        .eq("delivery_note_id", deliveryNoteId);
      if (error) throw error;
      return (data ?? []) as DeliveryNoteLineBalance[];
    },
  });
}