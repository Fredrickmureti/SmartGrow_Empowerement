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
  /** What the operator typed, in `packaging_name`; base qty is `counted_qty`. */
  entered_qty: number | null;
  packaging_id: string | null;
  packaging_name: string | null;
  variance_qty: number | null;

  counted_at: string | null;
  counted_by: string | null;
  assigned_to: string | null;
  is_blind: boolean;
  recount_round: number | null;
  recount_of_line_id: string | null;
  /** Capture-time classification — permanent audit truth, never rewritten. */
  tolerance_outcome: string | null;
  /** Resolution of the Inventory decision: pending | approved | rejected. */
  approval_state: string | null;
  approval_actor_id: string | null;
  approval_at: string | null;
  approval_note: string | null;
  variance_reason: string | null;
  serial_numbers: string[] | null;
  expiry_date: string | null;
}

/**
 * A line only still blocks on a supervisor while the Inventory decision is
 * outstanding. Once the linked count is approved/posted, the tolerance flag
 * is history, not a pending task.
 */
export function countLineAwaitsApproval(
  l: Pick<CountLineRow, "tolerance_outcome" | "approval_state">,
): boolean {
  return l.tolerance_outcome === "approval_required" && (l.approval_state ?? "pending") === "pending";
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

/**
 * How a count line names its product on screen.
 *
 * `get_count_lines` LEFT JOINs `products`, so a line whose product has
 * since been deleted (or that came from a pre-hardening session created
 * through the now-dropped legacy RPC) carries a NULL name and SKU. A raw
 * UUID is not a product name — a counter cannot walk to a bin and find
 * "b0791390-…" — so an unresolvable product is labelled as missing and the
 * identifier is kept out of the operator's way.
 */
export function countLineProductLabel(l: Pick<CountLineRow, "product_name" | "product_sku">): string {
  return l.product_name?.trim() || l.product_sku?.trim() || "Product no longer in catalogue";
}

/** Secondary line under the product name — the SKU, when it adds anything. */
export function countLineProductSubLabel(
  l: Pick<CountLineRow, "product_name" | "product_sku">,
): string | null {
  const sku = l.product_sku?.trim();
  if (!sku) return null;
  if (!l.product_name?.trim()) return null; // the SKU is already the label
  return sku;
}


/**
 * "4 × Case (48 ea)" — what the counter actually entered, when they counted in
 * a packaging level rather than base units. Sourced from the line's own
 * `entered_qty` / `packaging_name`, never re-derived in the browser, so review
 * shows the same figures the server converted.
 */
export function countLineEnteredLabel(
  l: Pick<CountLineRow, "entered_qty" | "packaging_name" | "counted_qty">,
): string | null {
  if (!l.packaging_name || l.entered_qty == null) return null;
  return `${Number(l.entered_qty)} × ${l.packaging_name}`;
}
