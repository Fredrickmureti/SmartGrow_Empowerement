/**
 * SSCC-18 client seam (ADR 0105, Phase 4).
 *
 * Serial Shipping Container Codes are minted SERVER-SIDE only:
 * `wms_sscc_allocate` is atomic against the per-business GS1 serial counter,
 * never recycles a serial, and is idempotent per (entity_type, entity_id) so
 * re-opening the dialog or replaying an offline action returns the SAME code.
 *
 * The client's only jobs are: ask for the code, render the GS1-128 payload,
 * and report prints/reprints back into the audit ledger.
 */
import { supabase } from "@/integrations/supabase/client";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";

export type SsccEntityType = "pack_carton" | "lpn" | "pallet" | "shipment" | "manual";

export interface SsccAllocation {
  sscc: string;
  status: string;
  reused?: boolean;
  entity_type?: string;
  entity_id?: string | null;
}

export interface SsccLabelPayload {
  sscc: string;
  status: string;
  valid: boolean;
  element_string: string;
  barcode_data: string;
  hri: string;
  symbology: string;
  packaging?: { id: string; code: string; name: string; packaging_class: string } | null;
}

/** Allocate (or re-read) the SSCC bound to a handling unit. */
export async function allocateSscc(input: {
  businessId: string;
  entityType: SsccEntityType;
  entityId?: string | null;
  count?: number;
  packagingTypeId?: string | null;
  warehouseId?: string | null;
}): Promise<SsccAllocation> {
  const { data } = await replayGuardedCall<Record<string, unknown>>("wms_sscc_allocate", {
    p_business_id: input.businessId,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId ?? null,
    p_count: input.count ?? 1,
    p_options: {
      packaging_type_id: input.packagingTypeId ?? null,
      warehouse_id: input.warehouseId ?? null,
    },
  });
  const payload = (data ?? {}) as Record<string, unknown>;
  const list = payload.sscc_list as string[] | undefined;
  const sscc = (payload.sscc as string | undefined) ?? list?.[0];
  if (!sscc) throw new Error("SSCC allocation returned no code");
  return {
    sscc,
    status: (payload.status as string) ?? "assigned",
    reused: Boolean(payload.reused),
    entity_type: payload.entity_type as string | undefined,
    entity_id: (payload.entity_id as string | null) ?? null,
  };
}

/** Read the GS1 label payload for an SSCC (barcode data, HRI, symbology). */
export async function fetchSsccLabelPayload(
  businessId: string,
  sscc: string,
): Promise<SsccLabelPayload> {
  const { data, error } = await supabase.rpc("wms_sscc_label_payload", {
    p_business_id: businessId,
    p_sscc: sscc,
    p_mark_printed: false,
  });
  if (error) throw error;
  return data as unknown as SsccLabelPayload;
}

/** Record a print or reprint of an SSCC label in the audit ledger. */
export async function markSsccPrinted(input: {
  businessId: string;
  sscc: string;
  copies?: number;
  isReprint?: boolean;
  reason?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await replayGuardedCall("wms_sscc_mark_printed", {
    p_business_id: input.businessId,
    p_sscc: input.sscc,
    p_copies: input.copies ?? 1,
    p_is_reprint: input.isReprint ?? false,
    p_reason: input.reason ?? null,
    p_payload: input.payload ?? {},
  });
}
