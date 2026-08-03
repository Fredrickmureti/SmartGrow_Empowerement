/**
 * Variance reason codes — mirrors the `wms_count_variance_reason` enum.
 *
 * Enterprise WMS platforms (SAP EWM "difference reason", Manhattan
 * "adjustment reason") require every posted count difference to carry a
 * coded cause so shrinkage can be trended and root-caused. The list is
 * enum-keyed on purpose: free text is not analysable.
 */
import type { Database } from "@/integrations/supabase/types";

export type VarianceReason = Database["public"]["Enums"]["wms_count_variance_reason"];

export const VARIANCE_REASONS: { value: VarianceReason; label: string; hint: string }[] = [
  { value: "damage", label: "Damaged stock", hint: "Found broken or unsellable in the bin" },
  { value: "mis_pick", label: "Picked in error", hint: "Wrong item or quantity taken on an earlier pick" },
  { value: "wrong_location", label: "Stored in the wrong bin", hint: "Stock exists, but not where the system expected" },
  { value: "shrinkage", label: "Shrinkage / theft", hint: "Stock is gone with no document trail" },
  { value: "receiving_error", label: "Receiving error", hint: "Booked in at the wrong quantity" },
  { value: "production_error", label: "Production error", hint: "Consumed or produced at the wrong quantity" },
  { value: "duplicate_count", label: "Counted twice", hint: "The same stock was recorded on more than one line" },
  { value: "unknown_loss", label: "Cause unknown", hint: "Investigated, no explanation found" },
  { value: "system_error", label: "System error", hint: "The recorded on-hand figure was wrong" },
];

export function varianceReasonLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return VARIANCE_REASONS.find((r) => r.value === value)?.label ?? value;
}

/** Tolerance outcomes returned by `record_count`. */
export type ToleranceOutcome = "within_tolerance" | "recount_required" | "approval_required";

export const TOLERANCE_COPY: Record<ToleranceOutcome, { label: string; tone: "success" | "warning" | "danger" }> = {
  within_tolerance: { label: "Within tolerance", tone: "success" },
  recount_required: { label: "Recount required", tone: "warning" },
  approval_required: { label: "Needs approval", tone: "danger" },
};
