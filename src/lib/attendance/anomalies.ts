/**
 * Pure derivation of per-row attendance anomalies.
 *
 * Reads from existing `AttendanceRecord` shape plus optional
 * `AttendanceSettings`. No DB calls. Used by AnomalyBadge, the roster
 * row, the Reports "Anomalies" bucket, and tests.
 */
import type { AttendanceRecord } from "@/hooks/useAttendance";
import type { AttendanceSettings } from "@/hooks/hr/useAttendanceSettings";

export type AnomalyCode =
  | "missing_out"
  | "late"
  | "early_leave"
  | "over_threshold"
  | "long_session"
  | "ot_no_preapproval";

export interface Anomaly {
  code: AnomalyCode;
  label: string;
  tone: "amber" | "rose" | "blue";
}

const LABELS: Record<AnomalyCode, { label: string; tone: Anomaly["tone"] }> = {
  missing_out: { label: "Missing clock-out", tone: "rose" },
  late: { label: "Late arrival", tone: "amber" },
  early_leave: { label: "Early leave", tone: "amber" },
  over_threshold: { label: "Over threshold", tone: "blue" },
  long_session: { label: "Stale session", tone: "rose" },
  ot_no_preapproval: { label: "OT not pre-approved", tone: "amber" },
};

export function detectAnomalies(
  r: Pick<
    AttendanceRecord,
    | "clock_in"
    | "clock_out"
    | "attendance_date"
    | "worked_hours"
    | "overtime_hours"
    | "status"
    | "late_minutes"
    | "early_leave_minutes"
  >,
  settings?: Partial<AttendanceSettings> | null,
  now: Date = new Date(),
): Anomaly[] {
  const out: Anomaly[] = [];
  const overtimeThreshold = settings?.overtime_threshold_hours ?? 8;
  const staleHours = settings?.auto_checkout_after_hours ?? 16;
  const requireOtPreapproval = settings?.require_ot_preapproval ?? false;

  const today = now.toISOString().split("T")[0];
  const isToday = r.attendance_date === today;

  // Missing clock-out — only on past days (today is still open).
  if (r.clock_in && !r.clock_out && !isToday) {
    out.push({ code: "missing_out", ...LABELS.missing_out });
  }

  // Stale open session (today, but past auto-checkout window).
  if (r.clock_in && !r.clock_out && isToday) {
    const elapsedH = (now.getTime() - new Date(r.clock_in).getTime()) / 3_600_000;
    if (elapsedH > staleHours) {
      out.push({ code: "long_session", ...LABELS.long_session });
    }
  }

  if ((r.late_minutes ?? 0) > 0 || r.status === "late") {
    out.push({ code: "late", ...LABELS.late });
  }

  if ((r.early_leave_minutes ?? 0) > 0) {
    out.push({ code: "early_leave", ...LABELS.early_leave });
  }

  if ((r.worked_hours ?? 0) > overtimeThreshold + 4) {
    out.push({ code: "over_threshold", ...LABELS.over_threshold });
  }

  if (requireOtPreapproval && (r.overtime_hours ?? 0) > 0) {
    // We can't see overtime_requests from the row alone; flag for review.
    // Consumers may suppress when they know an approved request exists.
    out.push({ code: "ot_no_preapproval", ...LABELS.ot_no_preapproval });
  }

  return out;
}
