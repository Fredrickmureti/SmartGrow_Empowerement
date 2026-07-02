/**
 * Multi-Unit Inventory — stock_movements ledger helper.
 *
 * Every code path that records a movement (POS sale, invoice post, GRN,
 * delivery note, return, scrap, physical count, transfer …) MUST go
 * through `recordStockMovement` so pack provenance is captured uniformly.
 *
 * The `quantity` field is ALWAYS the signed base-unit amount that the
 * warehouse balance moves by. `source_packaging_id` / `source_uom_id`
 * snapshot the unit the originating transaction line was created in so
 * movement reports can pivot by transaction unit ("Sold 1 Box (10 ea)").
 */
import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert } from "@/integrations/supabase/types";

export type StockMovementInsert = TablesInsert<"stock_movements">;

export interface RecordStockMovementInput
  extends Omit<StockMovementInsert, "source_packaging_id" | "source_uom_id"> {
  /** Packaging row from the originating transaction line, if any. */
  source_packaging_id?: string | null;
  /** Display UoM (usually product.base_uom_id) from the originating line. */
  source_uom_id?: string | null;
}

/**
 * Insert a stock_movements row with pack provenance preserved.
 *
 * `quantity` is the signed base-unit delta. Pass the originating line's
 * `packaging_id` and `display_uom_id` so the ledger remembers HOW the
 * stock change was transacted, not just how many base units moved.
 */
export async function recordStockMovement(
  input: RecordStockMovementInput,
): Promise<{ data: StockMovementInsert | null; error: unknown }> {
  const payload: StockMovementInsert = {
    ...input,
    source_packaging_id: input.source_packaging_id ?? null,
    source_uom_id: input.source_uom_id ?? null,
  };
  const { data, error } = await supabase
    .from("stock_movements")
    .insert(payload)
    .select()
    .maybeSingle();
  return { data: data as StockMovementInsert | null, error };
}

/**
 * Batch variant. Pass a homogenous array; each entry inherits the same
 * pack-provenance contract as `recordStockMovement`.
 */
export async function recordStockMovements(
  inputs: RecordStockMovementInput[],
): Promise<{ data: StockMovementInsert[] | null; error: unknown }> {
  if (!inputs.length) return { data: [], error: null };
  const payload: StockMovementInsert[] = inputs.map((i) => ({
    ...i,
    source_packaging_id: i.source_packaging_id ?? null,
    source_uom_id: i.source_uom_id ?? null,
  }));
  const { data, error } = await supabase
    .from("stock_movements")
    .insert(payload)
    .select();
  return { data: (data ?? null) as StockMovementInsert[] | null, error };
}
