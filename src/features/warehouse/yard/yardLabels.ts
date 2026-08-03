/**
 * Yard labelling (ADR 0086 Phase 4).
 *
 * Two physical artefacts leave the printer in a yard:
 *  - a **trailer placard** hung on the unit while it is parked, so a
 *    jockey can scan it and act without radio traffic;
 *  - a **yard slot label** fixed to the parking position itself.
 *
 * Printing stays on the enterprise print platform (`printWmsLabel` →
 * `PrintService`); this module owns only the yard-specific variable
 * binding so template tokens are named in exactly one place.
 */
import { printWmsLabel, WMS_LABEL_KEY } from "@/features/warehouse/labels/wmsLabels";
import type { VisitRow, YardSlotRow } from "./yardModel";
import { YARD_ZONE_LABEL } from "./yardModel";

function stamp(iso: string | null | undefined): string {
  return iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") : "";
}

export function trailerPlacardVars(visit: VisitRow): Record<string, string> {
  return {
    trailer_code: visit.trailer_ref,
    carrier_name: visit.carrier?.name ?? "Walk-in",
    slot_code: visit.slot?.code ?? (visit.dock ? `Dock ${visit.dock.code}` : "Unparked"),
    seal_in: visit.seal_in ?? "—",
    arrived_at: stamp(visit.arrived_at),
    // Scanning the placard resolves the visit, not the trailer: a unit can
    // be on site many times and each visit is its own chain of custody.
    visit_code: visit.id,
  };
}

export function yardSlotLabelVars(slot: YardSlotRow): Record<string, string> {
  return {
    slot_code: slot.code,
    zone_kind: slot.zone_kind ? YARD_ZONE_LABEL[slot.zone_kind] : "Yard",
  };
}

export function printTrailerPlacard(opts: {
  orgId: string;
  visit: VisitRow;
  businessId?: string | null;
  branchId?: string | null;
  copies?: number;
  isReprint?: boolean;
}) {
  return printWmsLabel({
    key: WMS_LABEL_KEY.TRAILER_PLACARD,
    orgId: opts.orgId,
    businessId: opts.businessId ?? null,
    branchId: opts.branchId ?? null,
    sourceDocType: "wms_trailer_visit",
    sourceDocId: opts.visit.id,
    copies: opts.copies ?? 1,
    isReprint: opts.isReprint ?? false,
    vars: trailerPlacardVars(opts.visit),
  });
}

export function printYardSlotLabel(opts: {
  orgId: string;
  slot: YardSlotRow;
  businessId?: string | null;
  branchId?: string | null;
  copies?: number;
  isReprint?: boolean;
}) {
  return printWmsLabel({
    key: WMS_LABEL_KEY.YARD_SLOT,
    orgId: opts.orgId,
    businessId: opts.businessId ?? null,
    branchId: opts.branchId ?? null,
    sourceDocType: "wms_yard_slot",
    sourceDocId: opts.slot.id,
    copies: opts.copies ?? 1,
    isReprint: opts.isReprint ?? false,
    vars: yardSlotLabelVars(opts.slot),
  });
}
