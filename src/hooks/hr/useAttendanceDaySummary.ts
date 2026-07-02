/**
 * useAttendanceDaySummary — Odoo-style derived attendance metrics.
 *
 * The single source of truth for "Present / Late / Absent / On leave" across
 * every HR surface. Instead of counting rows whose `attendance.status` column
 * equals a literal string (which is brittle and produces 0 when a row is open
 * or hasn't been finalized), we derive presence from the *existence* of an
 * attendance line on the business day, exactly like `hr.attendance` in Odoo.
 *
 * Definitions (mirrors Odoo Enterprise):
 *   - Present     : distinct employees with any attendance line on `date`
 *                   (open or closed) whose status is not absent/on_leave/holiday.
 *   - Late        : attendance lines on `date` with late_minutes > 0
 *                   OR status='late'.
 *   - Absent      : scoped active employees MINUS present MINUS on_leave
 *                   MINUS holiday.
 *   - On leave    : employees with an approved leave_request covering `date`.
 *   - Holiday     : employees affected by a public_holiday on `date`
 *                   (org-wide or branch-targeted).
 *
 * The hook returns Sets keyed by employee_id so the roster can synthesize an
 * employee-day row for absent employees that have no attendance record.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import type { AttendanceRecord } from "@/hooks/useAttendance";

export interface ScopedEmployee {
  id: string;
  /** @deprecated mirror of primary_branch_id during Phase B; remove in Phase E */
  branch_id?: string | null;
  /** Current primary branch assignment from v_employees_canonical. */
  primary_branch_id?: string | null;
  /** All open branch assignments. Empty = HQ/remote (visible to every branch). */
  branch_ids?: string[] | null;
  is_active?: boolean;
}

export interface AttendanceDaySummary {
  /** Distinct employee_ids present on the date (attendance line exists, not absent/leave/holiday). */
  presentEmployeeIds: Set<string>;
  /** Employee_ids on approved leave covering the date. */
  onLeaveEmployeeIds: Set<string>;
  /** Employee_ids affected by a public holiday on the date. */
  holidayEmployeeIds: Set<string>;
  /** Attendance rows considered late for the date. */
  lateRecords: AttendanceRecord[];
  presentCount: number;
  lateCount: number;
  absentCount: number;
  onLeaveCount: number;
  holidayCount: number;
  expectedCount: number;
  /** Lookup so the roster can render the right pseudo-status for an empty day. */
  statusFor: (employeeId: string) => "present" | "late" | "on_leave" | "holiday" | "absent";
}

export function useAttendanceDaySummary(params: {
  date: string;
  records: AttendanceRecord[];
  scopedActiveEmployees: ScopedEmployee[];
}): AttendanceDaySummary {
  const { date, records, scopedActiveEmployees } = params;
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  // Approved leave covering `date` for the active business.
  const { data: leaveRows = [] } = useQuery({
    queryKey: ["attendance-day-summary-leave", currentOrg?.id, currentBusiness?.id, date],
    enabled: !!currentOrg?.id && !!currentBusiness?.id && !!date,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leave_requests")
        .select("employee_id, start_date, end_date, status")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .eq("status", "approved")
        .lte("start_date", date)
        .gte("end_date", date);
      if (error) throw error;
      return (data ?? []) as { employee_id: string }[];
    },
  });

  // Public holidays for the date.
  const { data: holidayRows = [] } = useQuery({
    queryKey: ["attendance-day-summary-holiday", currentOrg?.id, currentBusiness?.id, date],
    enabled: !!currentOrg?.id && !!currentBusiness?.id && !!date,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("public_holidays")
        .select("date, applies_to_all, branch_ids, business_id, is_active")
        .eq("organization_id", currentOrg!.id)
        .eq("date", date)
        .eq("is_active", true);
      if (error) throw error;
      // Match holidays for this business (or org-wide rows with NULL business_id).
      return (data ?? []).filter(
        (h: any) => !h.business_id || h.business_id === currentBusiness?.id,
      );
    },
  });

  return useMemo(() => {
    const todayRecs = records.filter((r) => r.attendance_date === date);

    const onLeaveIds = new Set<string>(
      (leaveRows as any[]).map((r) => r.employee_id).filter(Boolean),
    );

    // Holiday set: employees whose branch is covered by any holiday row.
    const holidayIds = new Set<string>();
    if (holidayRows.length > 0) {
      for (const emp of scopedActiveEmployees) {
        // An employee is covered by a holiday when:
        //   - the holiday applies to all branches, OR
        //   - the holiday's branch list intersects any of the employee's
        //     active branch assignments (primary or otherwise). HQ/remote
        //     employees (no assignments) are only affected by applies_to_all.
        const empBranches: string[] =
          (emp.branch_ids && emp.branch_ids.length > 0)
            ? emp.branch_ids
            : (emp.primary_branch_id ? [emp.primary_branch_id]
               : (emp.branch_id ? [emp.branch_id] : []));
        for (const h of holidayRows as any[]) {
          const covers =
            h.applies_to_all ||
            !h.branch_ids ||
            h.branch_ids.length === 0 ||
            empBranches.some((b) => h.branch_ids.includes(b));
          if (covers) {
            holidayIds.add(emp.id);
            break;
          }
        }
      }
    }

    // Present = any attendance line today whose status is not absent/leave/holiday.
    // An OPEN session (clock_out IS NULL) ALWAYS counts as present even if its
    // status column lags behind — enterprise parity (Odoo, Workday).
    const presentIds = new Set<string>();
    for (const r of todayRecs) {
      if (r.clock_in && !r.clock_out) {
        presentIds.add(r.employee_id);
        continue;
      }
      if (r.status === "absent" || r.status === "on_leave" || r.status === "holiday") continue;
      presentIds.add(r.employee_id);
    }

    const lateRecords = todayRecs.filter(
      (r) => (r.late_minutes ?? 0) > 0 || r.status === "late",
    );
    const lateIds = new Set(lateRecords.map((r) => r.employee_id));

    // Expected = scoped active employees; absent = expected − present − leave − holiday.
    const expectedIds = new Set(scopedActiveEmployees.map((e) => e.id));
    let absentCount = 0;
    for (const id of expectedIds) {
      if (presentIds.has(id)) continue;
      if (onLeaveIds.has(id)) continue;
      if (holidayIds.has(id)) continue;
      absentCount++;
    }

    const statusFor = (employeeId: string) => {
      if (lateIds.has(employeeId)) return "late" as const;
      if (presentIds.has(employeeId)) return "present" as const;
      if (onLeaveIds.has(employeeId)) return "on_leave" as const;
      if (holidayIds.has(employeeId)) return "holiday" as const;
      return "absent" as const;
    };

    return {
      presentEmployeeIds: presentIds,
      onLeaveEmployeeIds: onLeaveIds,
      holidayEmployeeIds: holidayIds,
      lateRecords,
      presentCount: presentIds.size,
      lateCount: lateIds.size,
      absentCount,
      onLeaveCount: onLeaveIds.size,
      holidayCount: holidayIds.size,
      expectedCount: expectedIds.size,
      statusFor,
    };
  }, [records, date, leaveRows, holidayRows, scopedActiveEmployees]);
}
