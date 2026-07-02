/**
 * Three-way match helpers (Odoo-aligned).
 *
 * The DB trigger `sync_po_line_billed_quantities` is the source of truth and
 * blocks over-billing at the database level. These helpers exist to give the
 * UI a friendlier preview (so users see "0 left to bill" before they click
 * Save) and to compute proposed quantities when creating a Bill from a PO.
 *
 * Convention:
 *   to_bill = quantity_received − quantity_billed
 *   (we bill against received, not ordered, to keep AP aligned with stock)
 */
import { supabase } from "@/integrations/supabase/client";

export interface POLineMatchState {
  po_item_id: string;
  product_id: string | null;
  description: string;
  quantity_ordered: number;
  quantity_received: number;
  quantity_billed: number;
  quantity_to_bill: number;
  unit_price: number;
  tax_rate: number;
  account_id: string | null;
  sort_order: number;
}

/**
 * Loads the current three-way match state for every line of a PO.
 * Used by the "Create Bill from PO" dialog to pre-populate sensible defaults.
 */
export async function loadPOMatchState(
  purchaseOrderId: string,
): Promise<POLineMatchState[]> {
  const { data, error } = await supabase
    .from("purchase_order_items")
    .select(
      "id, product_id, description, quantity, quantity_received, quantity_billed, unit_price, tax_rate, account_id, sort_order",
    )
    .eq("purchase_order_id", purchaseOrderId)
    .order("sort_order", { ascending: true });

  if (error) throw error;
  return (data || []).map((line: any) => {
    const received = Number(line.quantity_received || 0);
    const billed = Number(line.quantity_billed || 0);
    return {
      po_item_id: line.id,
      product_id: line.product_id,
      description: line.description,
      quantity_ordered: Number(line.quantity || 0),
      quantity_received: received,
      quantity_billed: billed,
      quantity_to_bill: Math.max(0, received - billed),
      unit_price: Number(line.unit_price || 0),
      tax_rate: Number(line.tax_rate || 0),
      account_id: line.account_id,
      sort_order: Number(line.sort_order || 0),
    };
  });
}

/**
 * Client-side preview of the three-way match check. The DB trigger is the
 * authoritative gate, but surfacing this in the UI saves a round-trip.
 */
export function validateBillLinesAgainstPO(
  proposed: { po_item_id: string; quantity: number }[],
  poState: POLineMatchState[],
): { ok: boolean; errors: string[] } {
  const stateById = new Map(poState.map((s) => [s.po_item_id, s]));
  const errors: string[] = [];
  for (const line of proposed) {
    const s = stateById.get(line.po_item_id);
    if (!s) continue;
    if (line.quantity > s.quantity_to_bill) {
      errors.push(
        `"${s.description}": billing ${line.quantity} but only ${s.quantity_to_bill} unit(s) are available (received ${s.quantity_received}, already billed ${s.quantity_billed}).`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}
