/**
 * WMS canonical label keys — the ONLY IDs the WMS surface uses when
 * calling into the print pipeline. Kept in sync with the SQL seeder
 * `wms_seed_default_label_templates`. A guard test asserts the two
 * lists match so a template renamed on one side breaks CI, not prod.
 */
import { printLabel, type LabelPrintResult } from "@/services/printing/PrintService";

export const WMS_LABEL_KEY = {
  LPN: "wms.label.lpn",
  BIN: "wms.label.bin",
  SHIPPING: "wms.label.shipping",
  PACKING_SLIP: "wms.label.packing_slip",
  /** ADR 0105 Phase 4 — carton / handling unit, GS1 SSCC-18 barcode. */
  CARTON: "wms.label.carton",
} as const;


export type WmsLabelKey = (typeof WMS_LABEL_KEY)[keyof typeof WMS_LABEL_KEY];

export const WMS_LABEL_KEYS: readonly WmsLabelKey[] = Object.freeze(
  Object.values(WMS_LABEL_KEY),
);

export interface PrintWmsLabelInput {
  key: WmsLabelKey;
  orgId: string;
  vars: Record<string, string | number | null | undefined>;
  businessId?: string | null;
  branchId?: string | null;
  sourceDocType?: string;
  sourceDocId?: string;
  copies?: number;
  isReprint?: boolean;
}

/**
 * Print a canonical WMS label. Thin wrapper so callers don't reach into
 * `PrintService` directly — keeps the label-key ↔ template-key mapping
 * inside this module and lets the guard test enforce it.
 */
export async function printWmsLabel(input: PrintWmsLabelInput): Promise<LabelPrintResult> {
  return printLabel({
    orgId: input.orgId,
    templateKey: input.key,
    vars: input.vars,
    businessId: input.businessId ?? null,
    branchId: input.branchId ?? null,
    sourceDocType: input.sourceDocType,
    sourceDocId: input.sourceDocId,
    copies: input.copies,
    isReprint: input.isReprint,
    workflow:
      input.key === WMS_LABEL_KEY.SHIPPING || input.key === WMS_LABEL_KEY.CARTON
        ? "shipping"
        : input.key === WMS_LABEL_KEY.LPN || input.key === WMS_LABEL_KEY.BIN
          ? "receiving"
          : "generic",

  });
}
