/**
 * useCountLines — the ONLY sanctioned read path for count lines.
 *
 * `get_count_lines` masks `system_qty` / `variance_qty` while a blind
 * session is still being counted. Reading `wms_count_lines` directly from
 * the client would defeat blind counting, so no surface may do that.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface CountLineRow {
  id: string;
  location_id: string;
  location_code: string | null;
  location_name: string | null;
  product_id: string;
  product_name: string | null;
  product_sku: string | null;
  lot_number: string | null;
  system_qty: number | null;
  counted_qty: number | null;
  variance_qty: number | null;
  counted_at: string | null;
  assigned_to: string | null;
  is_blind: boolean;
  recount_round: number | null;
  recount_of_line_id: string | null;
  tolerance_outcome: string | null;
  variance_reason: string | null;
  serial_numbers: string[] | null;
  expiry_date: string | null;
}

export function useCountLines(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["wms-count-lines", sessionId],
    enabled: !!sessionId,
    queryFn: async (): Promise<CountLineRow[]> => {
      const { data, error } = await supabase.rpc("get_count_lines", {
        p_session_id: sessionId!,
      });
      if (error) throw error;
      return (data ?? []) as unknown as CountLineRow[];
    },
  });
}
