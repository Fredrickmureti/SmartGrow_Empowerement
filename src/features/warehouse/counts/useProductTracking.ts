/**
 * useProductTracking — reads the per-product verification switches that
 * decide what a counter must confirm at the bin (ADR 0025).
 *
 * A count is evidence: for a lot-tracked, serial-tracked or expiry-tracked
 * product, a bare quantity is not evidence. These flags drive which extra
 * captures the counting screens demand before a line can be recorded.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ProductTracking {
  is_lot_tracked: boolean;
  is_serial_tracked: boolean;
  is_expiry_tracked: boolean;
}

export function useProductTracking(productId: string | null | undefined) {
  return useQuery({
    queryKey: ["product-tracking", productId],
    enabled: !!productId,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ProductTracking> => {
      const { data, error } = await supabase
        .from("products")
        .select("is_lot_tracked, is_serial_tracked, is_expiry_tracked")
        .eq("id", productId!)
        .maybeSingle();
      if (error) throw error;
      return {
        is_lot_tracked: !!data?.is_lot_tracked,
        is_serial_tracked: !!data?.is_serial_tracked,
        is_expiry_tracked: !!data?.is_expiry_tracked,
      };
    },
  });
}

/**
 * Serial capture is only complete when the number of scanned serials
 * equals the counted quantity — that is the whole point of serial
 * control. Returns null when the capture is acceptable, or the reason it
 * is not.
 */
export function serialCaptureError(
  tracking: ProductTracking | undefined,
  countedQty: number,
  serials: string[],
): string | null {
  if (!tracking?.is_serial_tracked) return null;
  if (serials.length !== Math.round(countedQty)) {
    return `Scan ${Math.round(countedQty)} serial number${Math.round(countedQty) === 1 ? "" : "s"} — ${serials.length} captured.`;
  }
  const seen = new Set(serials.map((s) => s.trim().toLowerCase()));
  if (seen.size !== serials.length) return "The same serial number was scanned twice.";
  return null;
}
