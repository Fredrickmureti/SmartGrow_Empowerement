/**
 * Packaging Master — client seam for the server-side cartonization engine
 * (ADR 0105, Phase 3).
 *
 * The client NEVER decides which box fits. `suggest_packaging` owns the
 * geometry (rotation-aware fit on all three axes), the volume/weight unit
 * split, dimensional-weight billing and carrier/hazmat/stock filtering,
 * and it returns an explainable failure reason instead of an empty list.
 *
 * Assignment of the chosen packaging to an open carton also goes through a
 * sanctioned RPC (`assign_packaging_to_pack`), routed via the replay ledger
 * so a double-click or a drained offline scan cannot double-count tare.
 */
import { supabase } from "@/integrations/supabase/client";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";

export interface PackagingSuggestionLine {
  product_id: string;
  quantity: number;
}

export interface PackagingSuggestionOptions {
  warehouse_id?: string | null;
  carrier_id?: string | null;
  service_code?: string | null;
  hazmat_class?: string | null;
  temp_min_c?: number | null;
  temp_max_c?: number | null;
  packaging_classes?: string[];
  require_stock?: boolean;
  include_restricted?: boolean;
  limit?: number;
}

export interface PackagingCandidate {
  rank_no: number;
  packaging_type_id: string;
  code: string;
  name: string;
  packaging_class: string;
  lifecycle_status: string;
  units_needed: number;
  usable_cm3_per_unit: number;
  content_volume_cm3: number;
  fill_pct: number | null;
  actual_weight_kg: number;
  dim_weight_kg: number;
  billable_weight_kg: number;
  packaging_cost: number;
  carrier_surcharge: number;
  carrier_oversize: boolean;
  is_returnable: boolean | null;
  is_stackable: boolean | null;
  stock_on_hand: number | null;
  strategy: "single_unit" | "split_across_units";
}

export interface PackagingSuggestion {
  ok: boolean;
  reason?: string;
  unresolved?: Array<{ product_id: string; sku?: string; name?: string; reason: string }>;
  items?: unknown[];
  total_volume_cm3?: number;
  total_weight_kg?: number;
  largest_item_dimension_cm?: number;
  recommended?: PackagingCandidate | null;
  candidates: PackagingCandidate[];
}

/** Operator-facing copy for every failure code the engine can return. */
export const PACKAGING_FAILURE_COPY: Record<string, string> = {
  no_lines: "Nothing to pack yet.",
  missing_dimensions: "Some products have no LxWxH — measure them to enable packaging advice.",
  no_measurable_volume: "Picked lines have no measurable volume.",
  no_active_packaging: "No active packaging types exist for this business.",
  item_exceeds_all_packaging: "An item is larger than every packaging type — needs manual handling.",
  no_packaging_matches_constraints:
    "No packaging matches the carrier, stock, hazmat or temperature constraints.",
};

export function packagingFailureMessage(reason?: string | null): string {
  if (!reason) return "No packaging suggestion available.";
  return PACKAGING_FAILURE_COPY[reason] ?? `No packaging suggestion (${reason}).`;
}

export async function suggestPackaging(
  businessId: string,
  lines: PackagingSuggestionLine[],
  options: PackagingSuggestionOptions = {},
): Promise<PackagingSuggestion> {
  const { data, error } = await supabase.rpc("suggest_packaging", {
    p_business_id: businessId,
    p_lines: lines as unknown as never,
    p_options: options as unknown as never,
  });
  if (error) throw error;
  const payload = (data ?? { ok: false, reason: "no_lines", candidates: [] }) as unknown as
    PackagingSuggestion;
  return { ...payload, candidates: payload.candidates ?? [] };
}

/** Stamp a packaging type onto an open carton (idempotent, tare-safe). */
export async function assignPackagingToPack(
  cartonId: string,
  packagingTypeId: string,
): Promise<void> {
  await replayGuardedCall("assign_packaging_to_pack", {
    p_carton_id: cartonId,
    p_packaging_type_id: packagingTypeId,
  });
}
