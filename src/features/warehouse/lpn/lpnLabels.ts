/**
 * License-plate labelling — the single place plate labels are compiled,
 * previewed, printed and audited.
 *
 * Printing itself stays on the enterprise platform (`printWmsLabel` →
 * `PrintService`); this module only owns plate-specific variable binding,
 * the preview compile, and the reprint audit entry written to
 * `wms_lpn_events`.
 */
import { supabase } from "@/integrations/supabase/client";
import { renderLabelPayload } from "@/services/printing/labelDispatch";
import { printWmsLabel, WMS_LABEL_KEY } from "@/features/warehouse/labels/wmsLabels";
import type { LpnOverviewRow } from "./useLpnOps";

export const REPRINT_REASONS = [
  { value: "damaged", label: "Label damaged" },
  { value: "lost", label: "Label lost" },
  { value: "relabel", label: "Relabel / re-key" },
  { value: "extra_copy", label: "Extra copy" },
] as const;

export type ReprintReason = (typeof REPRINT_REASONS)[number]["value"];

export function lpnLabelVars(plate: LpnOverviewRow): Record<string, string> {
  return {
    lpn_code: plate.code,
    barcode: plate.code,
    lpn_type: plate.lpn_type,
    warehouse_name: plate.warehouse_name ?? "",
    current_location: plate.location_code
      ? `${plate.location_code}${plate.location_name ? ` ${plate.location_name}` : ""}`
      : "Unlocated",
    contents_summary: `${Number(plate.sku_count ?? 0)} SKU / ${Number(plate.total_quantity ?? 0)} units`,
    status: plate.status,
    created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
  };
}

export interface LpnLabelPreview {
  ok: boolean;
  error?: string;
  engine?: string;
  version?: number;
  media?: { widthMm: number; heightMm: number | null; dpi: number };
  /** Compiled label body, when the engine produces a text wire format. */
  body?: string;
}

/** Compile the label without dispatching it — Generate → Preview → Print. */
export async function previewLpnLabel(
  orgId: string,
  plate: LpnOverviewRow,
): Promise<LpnLabelPreview> {
  const rendered = await renderLabelPayload({
    orgId,
    templateKey: WMS_LABEL_KEY.LPN,
    vars: lpnLabelVars(plate),
    workflow: "receiving",
    branchId: plate.branch_id ?? null,
    warehouseId: plate.warehouse_id,
    sourceDocType: "wms_license_plate",
    sourceDocId: plate.id,
  });
  if (rendered.ok === false) return { ok: false, error: rendered.error };
  const payload = rendered.payload as Record<string, unknown>;
  const body =
    typeof payload.body === "string"
      ? payload.body
      : typeof payload.zpl === "string"
        ? payload.zpl
        : undefined;
  return {
    ok: true,
    engine: rendered.templateResolved.engine,
    version: rendered.templateResolved.version,
    media: rendered.mediaResolved
      ? {
          widthMm: rendered.mediaResolved.widthMm,
          heightMm: rendered.mediaResolved.heightMm,
          dpi: rendered.mediaResolved.dpi,
        }
      : undefined,
    body,
  };
}

export interface PrintLpnLabelInput {
  orgId: string;
  plate: LpnOverviewRow;
  copies?: number;
  isReprint?: boolean;
  reason?: ReprintReason | null;
}

/** Print (or reprint) a plate label and record the audit entry. */
export async function printLpnLabel(input: PrintLpnLabelInput) {
  const { orgId, plate, copies = 1, isReprint = false, reason = null } = input;
  const res = await printWmsLabel({
    key: WMS_LABEL_KEY.LPN,
    orgId,
    businessId: plate.business_id ?? null,
    branchId: plate.branch_id ?? null,
    sourceDocType: "wms_license_plate",
    sourceDocId: plate.id,
    copies,
    isReprint,
    vars: lpnLabelVars(plate),
  });

  if (res.success) {
    // Audit the label event on the plate's own ledger so a reprint is
    // visible to the supervisor without trawling print jobs.
    await (supabase as any).from("wms_lpn_events").insert({
      organization_id: plate.organization_id,
      business_id: plate.business_id,
      branch_id: plate.branch_id ?? null,
      warehouse_id: plate.warehouse_id,
      lpn_id: plate.id,
      event_type: isReprint ? "label_reprinted" : "label_printed",
      payload: { copies, reason, job_ids: res.jobIds },
    });
  }
  return res;
}
