import { normalizeError } from "@/services/resilience";
/**
 * useGenerateAttendanceWorkEntries — period-locks attendance for a payroll
 * run and projects the canonical, typed Work Entries (WORK, OT, LEAVE_PAID,
 * LEAVE_UNPAID, HOLIDAY) via the single authoritative RPC
 * `payroll_work_entries_project(_run_id)`.
 *
 * ADR-0042: this is the only client surface that triggers Work Entry
 * generation. The legacy `attendance_generate_work_entries` RPC is now a
 * thin forwarder kept for one release.
 *
 * Returned summary exposes the per-type breakdown so the UI can render a
 * typed Work Entries panel rather than an opaque "Sync attendance" toast.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface WorkEntryTypeTotals {
  hours: number;
  overtime_hours: number;
  rows: number;
}

export interface WorkEntryProjectionSummary {
  employees: number;
  by_type: Record<string, WorkEntryTypeTotals>;
  sources_used: string[];
  locked_attendance_rows: number;
  preapproval_gate: boolean;
  /** Convenience: total normal (non-OT) hours across worked + paid leave + holiday. */
  hours: number;
  /** Convenience: total OT hours. */
  overtime_hours: number;
}

function coerceTotals(raw: unknown): WorkEntryTypeTotals {
  const t = (raw ?? {}) as Partial<WorkEntryTypeTotals>;
  return {
    hours: Number(t.hours ?? 0),
    overtime_hours: Number(t.overtime_hours ?? 0),
    rows: Number(t.rows ?? 0),
  };
}

export function useGenerateAttendanceWorkEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string): Promise<WorkEntryProjectionSummary> => {
      const { data, error } = await supabase.rpc(
        "payroll_work_entries_project" as any,
        { _run_id: runId } as any,
      );
      if (error) throw new Error(error.message || "Failed to project work entries");
      const d = (data ?? {}) as any;
      const byTypeRaw = (d.by_type ?? {}) as Record<string, unknown>;
      const by_type: Record<string, WorkEntryTypeTotals> = {};
      for (const [code, val] of Object.entries(byTypeRaw)) by_type[code] = coerceTotals(val);
      const hours =
        (by_type.WORK?.hours ?? 0) +
        (by_type.LEAVE_PAID?.hours ?? 0) +
        (by_type.HOLIDAY?.hours ?? 0);
      const overtime_hours = by_type.OT?.overtime_hours ?? 0;
      return {
        employees: Number(d.employees ?? 0),
        by_type,
        sources_used: Array.isArray(d.sources_used) ? d.sources_used.map(String) : [],
        locked_attendance_rows: Number(d.locked_attendance_rows ?? 0),
        preapproval_gate: Boolean(d.preapproval_gate ?? false),
        hours,
        overtime_hours,
      };
    },
    onSuccess: (s) => {
      const parts: string[] = [`${s.employees} employees`];
      if (s.by_type.WORK) parts.push(`${s.by_type.WORK.hours.toFixed(1)}h worked`);
      if (s.by_type.OT) parts.push(`${s.by_type.OT.overtime_hours.toFixed(1)}h OT`);
      if (s.by_type.LEAVE_PAID) parts.push(`${s.by_type.LEAVE_PAID.hours.toFixed(1)}h paid leave`);
      if (s.by_type.LEAVE_UNPAID) parts.push(`${s.by_type.LEAVE_UNPAID.hours.toFixed(1)}h unpaid leave`);
      if (s.by_type.HOLIDAY) parts.push(`${s.by_type.HOLIDAY.hours.toFixed(1)}h holiday`);
      toast.success(`Work entries projected · ${parts.join(" · ")}`);
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      qc.invalidateQueries({ queryKey: ["payroll-work-entries"] });
      qc.invalidateQueries({ queryKey: ["attendance"] });
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });
}

// Legacy type alias — kept so existing imports keep type-checking.
export type AttendanceWorkEntrySummary = WorkEntryProjectionSummary;
