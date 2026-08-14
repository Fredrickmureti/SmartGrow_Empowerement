/**
 * Handling units × Packaging Master (ADR 0105 §7, Phase 5).
 *
 * A license plate's physical identity IS a packaging type. The coarse
 * `wms_lpn_type` facet is derived server-side from the packaging class, so the
 * client never invents it — it only names the packaging.
 *
 * Both entry points are server-owned:
 *   - `wms_lpn_set_packaging` stamps packaging on a plate (business guarded,
 *     row_version checked, idempotent, audited on `wms_lpn_events`).
 *   - `wms_resolve_carton_scan` backs the `pack.carton` scan intent: an
 *     SSCC-18, a GS1 `(00)` element string or a bare plate code all resolve to
 *     one handling unit, its packaging and its location.
 */
import { supabase } from "@/integrations/supabase/client";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";

export interface HandlingUnitPackaging {
  id: string;
  code: string;
  name: string;
  packaging_class: string;
  lifecycle_status: string;
}

export interface CartonScanResolution {
  ok: boolean;
  reason?: string;
  sscc?: string | null;
  lpn?: {
    id: string;
    code: string;
    status: string;
    lpn_type: string;
    location_id: string | null;
    sealed_at: string | null;
    row_version: number | null;
  };
  packaging?: HandlingUnitPackaging | null;
  carton?: {
    id: string;
    sealed_at: string | null;
    weight_kg: number | null;
    sales_order_id: string | null;
  } | null;
}

/** Operator copy for every resolver failure code. */
export const CARTON_SCAN_FAILURE_COPY: Record<string, string> = {
  empty_scan: "Nothing scanned.",
  unknown_sscc: "That SSCC is not registered to this business.",
  unknown_code: "No handling unit matches that code.",
};

export function cartonScanFailureMessage(reason?: string | null): string {
  if (!reason) return "Scan could not be resolved.";
  return CARTON_SCAN_FAILURE_COPY[reason] ?? `Scan not resolved (${reason}).`;
}

/** Stamp a packaging type onto a handling unit (plate). */
export async function setLpnPackaging(input: {
  lpnId: string;
  packagingTypeId: string;
  /** Required: `wms_lpn_set_packaging` rejects a missing revision (Phase 6). */
  expectedVersion: number;
}): Promise<void> {
  await replayGuardedCall("wms_lpn_set_packaging", {
    _lpn_id: input.lpnId,
    _packaging_type_id: input.packagingTypeId,
    _expected_version: input.expectedVersion,
  });
}

/** Resolve a scanned carton/plate/SSCC back to its handling unit. */
export async function resolveCartonScan(
  businessId: string,
  code: string,
): Promise<CartonScanResolution> {
  const { data, error } = await supabase.rpc("wms_resolve_carton_scan", {
    p_business_id: businessId,
    p_code: code,
  });
  if (error) throw error;
  return (data ?? { ok: false, reason: "unknown_code" }) as unknown as CartonScanResolution;
}
