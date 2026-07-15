/**
 * hrStatusMap — the single source of truth for how HR record statuses
 * render across every ESS page (MyPayslips, MyLoans, MyLeave, MyShifts,
 * MyDocuments) and every admin/shared HR list surface.
 *
 * Consumers should render `<StatusBadge tone={tone}>{label}</StatusBadge>`
 * where `tone` and `label` come from `hrStatus(status)`. Do NOT add a
 * bespoke `{ status → colour }` map to a new page — extend this file.
 *
 * The tone vocabulary maps 1:1 to the design-system `StatusBadge` tones
 * (`neutral | info | success | warning | danger | accent`).
 */
import type { ComponentProps } from "react";
import type { StatusBadge } from "@/design-system";

export type HrStatusTone = NonNullable<
  ComponentProps<typeof StatusBadge>["tone"]
>;

interface HrStatusMeta {
  tone: HrStatusTone;
  label: string;
}

const MAP: Record<string, HrStatusMeta> = {
  // Generic lifecycle
  draft:            { tone: "neutral", label: "Draft" },
  requested:        { tone: "warning", label: "Awaiting review" },
  pending:          { tone: "warning", label: "Pending" },
  pending_approval: { tone: "warning", label: "Pending approval" },
  pending_second_approval: { tone: "warning", label: "Awaiting final approval" },
  submitted:        { tone: "info",    label: "Submitted" },
  in_review:        { tone: "info",    label: "In review" },
  approved:         { tone: "success", label: "Approved" },
  rejected:         { tone: "danger",  label: "Rejected" },
  cancelled:        { tone: "neutral", label: "Cancelled" },
  suspended:        { tone: "warning", label: "Suspended" },
  active:           { tone: "info",    label: "Active" },
  completed:        { tone: "success", label: "Completed" },
  expired:          { tone: "neutral", label: "Expired" },

  // Payslip / payroll
  paid:             { tone: "success", label: "Paid" },
  processing:       { tone: "info",    label: "Processing" },
  posted:           { tone: "success", label: "Posted" },
  finalized:        { tone: "success", label: "Finalized" },

  // Shifts / attendance
  scheduled:        { tone: "info",    label: "Scheduled" },
  swap_requested:   { tone: "warning", label: "Swap requested" },
  covered:          { tone: "success", label: "Covered" },

  // Documents
  uploaded:         { tone: "info",    label: "Uploaded" },
  signed:           { tone: "success", label: "Signed" },
  awaiting_signature: { tone: "warning", label: "Awaiting signature" },
};

/**
 * Resolve an HR status string to a tone + display label. Unknown
 * statuses fall back to a neutral badge that shows the raw status
 * humanised (`in_progress` → `In progress`).
 */
export function hrStatus(status: string | null | undefined): HrStatusMeta {
  if (!status) return { tone: "neutral", label: "—" };
  const key = status.toLowerCase();
  if (MAP[key]) return MAP[key];
  return {
    tone: "neutral",
    label: status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  };
}
