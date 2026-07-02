/**
 * attendanceData — server-build helpers for attendance report keys.
 *
 * Mirrors the bucket logic of the AttendanceReports page so that any
 * caller (live page, payroll lock action, scheduled email) can ask the
 * unified `render-report` engine to fetch + render attendance PDFs by
 * passing only `{ reportType, organizationId, businessId, dateFrom, dateTo, filters }`.
 *
 * Each row carries `_meta = { sourceDocType:"attendance", sourceDocId, employeeId }`
 * so the existing drill-down router can deep-link rows back to /hr/attendance.
 */
// deno-lint-ignore-file no-explicit-any
import type { ReportResult } from "../reportDataEngine.ts";

export type AttendanceReportKey =
  | "attendance_daily_log"
  | "attendance_late_arrivals"
  | "attendance_absences"
  | "attendance_payroll_ready"
  | "attendance_period_summary";

export interface AttendanceFilters {
  branchId?: string | null;
  employeeId?: string | null;
  departmentId?: string | null;
  status?: string | null;
}

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function empName(e: any): string {
  if (!e) return "Unknown";
  return `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim() || "Unknown";
}

async function loadDataset(
  supabase: any,
  orgId: string,
  businessId: string | undefined,
  dateFrom: string,
  dateTo: string,
  filters: AttendanceFilters,
) {
  let attQ = supabase
    .from("attendance")
    .select(
      "id, employee_id, attendance_date, clock_in, clock_out, worked_hours, overtime_hours, late_minutes, status, correction_status, is_locked, branch_id",
    )
    .eq("organization_id", orgId)
    .gte("attendance_date", dateFrom)
    .lte("attendance_date", dateTo)
    .order("attendance_date", { ascending: true });
  if (businessId) attQ = attQ.eq("business_id", businessId);
  if (filters.branchId) attQ = attQ.eq("branch_id", filters.branchId);
  if (filters.employeeId) attQ = attQ.eq("employee_id", filters.employeeId);
  if (filters.status) attQ = attQ.eq("status", filters.status);
  const { data: attendance = [], error: attErr } = await attQ;
  if (attErr) throw attErr;

  let empQ = supabase
    .from("employees")
    .select(
      "id, first_name, last_name, employee_number, branch_id, work_schedule_id, department_id, departments(name), employment_status",
    )
    .eq("organization_id", orgId);
  if (businessId) empQ = empQ.eq("business_id", businessId);
  const { data: employees = [], error: empErr } = await empQ;
  if (empErr) throw empErr;

  const { data: schedules = [] } = await supabase
    .from("work_schedules")
    .select("id, work_days")
    .eq("organization_id", orgId)
    .eq("is_active", true);

  const { data: branches = [] } = await supabase
    .from("branches")
    .select("id, name")
    .eq("organization_id", orgId);

  return { attendance, employees, schedules, branches };
}

function deptName(emp: any): string {
  return emp?.departments?.name ?? emp?.department_name ?? "—";
}

function branchName(branches: any[], id: string | null | undefined): string {
  if (!id) return "—";
  return branches.find((b) => b.id === id)?.name ?? "—";
}

function withMeta(row: any, sourceId: string | null, employeeId: string | null) {
  return Object.defineProperty(row, "_meta", {
    enumerable: false,
    value: { sourceDocType: "attendance", sourceDocId: sourceId, employeeId },
  });
}

/** Single dispatch — returns a ReportResult ready for renderReport. */
export async function buildAttendanceReport(
  supabase: any,
  reportType: AttendanceReportKey,
  orgId: string,
  businessId: string | undefined,
  dateFrom: string,
  dateTo: string,
  filters: AttendanceFilters = {},
  staleAfterHours = 16,
): Promise<ReportResult> {
  const { attendance, employees, schedules, branches } = await loadDataset(
    supabase,
    orgId,
    businessId,
    dateFrom,
    dateTo,
    filters,
  );
  const empById = new Map(employees.map((e: any) => [e.id, e]));
  const apply = (recs: any[]) =>
    recs.filter((r) => {
      if (filters.departmentId) {
        const e = empById.get(r.employee_id) as any;
        if (!e || e.department_id !== filters.departmentId) return false;
      }
      return true;
    });
  const filtered = apply(attendance);

  switch (reportType) {
    case "attendance_daily_log": {
      const rows = filtered.map((r: any) => {
        const e = empById.get(r.employee_id) as any;
        const row = {
          employee: empName(e),
          employee_number: e?.employee_number ?? "—",
          date: r.attendance_date,
          clock_in: fmtTime(r.clock_in),
          clock_out: fmtTime(r.clock_out),
          worked_hours: Number(r.worked_hours ?? 0),
          overtime_hours: Number(r.overtime_hours ?? 0),
          status: String(r.status ?? "").replace(/_/g, " "),
        };
        return withMeta(row, r.id, r.employee_id);
      });
      return { data: rows, summary: {} };
    }
    case "attendance_late_arrivals": {
      const late = filtered.filter(
        (r: any) => r.status === "late" || (r.late_minutes ?? 0) > 0,
      );
      const rows = late.map((r: any) => {
        const e = empById.get(r.employee_id) as any;
        const row = {
          employee: empName(e),
          date: r.attendance_date,
          clock_in: fmtTime(r.clock_in),
          late_minutes: Number(r.late_minutes ?? 0),
          branch: branchName(branches, r.branch_id),
        };
        return withMeta(row, r.id, r.employee_id);
      });
      return { data: rows, summary: {} };
    }
    case "attendance_payroll_ready": {
      const ready = filtered.filter(
        (r: any) =>
          r.clock_out && r.correction_status !== "pending" && !r.is_locked,
      );
      const rows = ready.map((r: any) => {
        const e = empById.get(r.employee_id) as any;
        const row = {
          employee: empName(e),
          date: r.attendance_date,
          worked_hours: Number(r.worked_hours ?? 0),
          overtime_hours: Number(r.overtime_hours ?? 0),
          locked: r.is_locked ? "Yes" : "No",
        };
        return withMeta(row, r.id, r.employee_id);
      });
      return { data: rows, summary: {} };
    }
    case "attendance_absences": {
      const recIdx = new Map<string, any>();
      for (const r of filtered as any[]) recIdx.set(`${r.employee_id}|${r.attendance_date}`, r);
      const todayStr = new Date().toISOString().slice(0, 10);
      const start = new Date(dateFrom + "T00:00:00Z");
      const end = new Date(dateTo + "T00:00:00Z");
      const rows: any[] = [];
      for (const emp of employees as any[]) {
        if (emp.employment_status && emp.employment_status !== "active") continue;
        if (filters.employeeId && emp.id !== filters.employeeId) continue;
        if (filters.branchId && emp.branch_id !== filters.branchId) continue;
        if (filters.departmentId && emp.department_id !== filters.departmentId) continue;
        if (!emp.work_schedule_id) continue;
        const sched = schedules.find((s: any) => s.id === emp.work_schedule_id) as any;
        if (!sched?.work_days) continue;
        for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
          const dateStr = d.toISOString().slice(0, 10);
          if (dateStr > todayStr) break;
          const dow = DOW[d.getUTCDay()];
          if (!sched.work_days[dow]) continue;
          const r = recIdx.get(`${emp.id}|${dateStr}`);
          if (r && (r.status === "on_leave" || r.status === "holiday" || r.clock_in)) continue;
          rows.push(
            withMeta(
              {
                employee: empName(emp),
                department: deptName(emp),
                date: dateStr,
                reason: r ? "No clock-in" : "No record",
              },
              null,
              emp.id,
            ),
          );
        }
      }
      return { data: rows, summary: {} };
    }
    case "attendance_period_summary": {
      type Agg = {
        employee: string;
        days: Set<string>;
        hours: number;
        ot: number;
        absences: number;
        lateDays: Set<string>;
        empId: string;
      };
      const byEmp = new Map<string, Agg>();
      for (const r of filtered as any[]) {
        const e = empById.get(r.employee_id) as any;
        const cur =
          byEmp.get(r.employee_id) ?? {
            employee: empName(e),
            days: new Set<string>(),
            hours: 0,
            ot: 0,
            absences: 0,
            lateDays: new Set<string>(),
            empId: r.employee_id,
          };
        if (r.clock_in) cur.days.add(r.attendance_date);
        cur.hours += Number(r.worked_hours ?? 0);
        cur.ot += Number(r.overtime_hours ?? 0);
        if (r.status === "late" || (r.late_minutes ?? 0) > 0)
          cur.lateDays.add(r.attendance_date);
        byEmp.set(r.employee_id, cur);
      }
      // Absences via scheduled-day diff
      const absences = await buildAttendanceReport(
        supabase,
        "attendance_absences",
        orgId,
        businessId,
        dateFrom,
        dateTo,
        filters,
        staleAfterHours,
      );
      for (const ar of absences.data as any[]) {
        const empId = (ar as any)._meta?.employeeId;
        if (!empId) continue;
        const cur =
          byEmp.get(empId) ?? {
            employee: ar.employee,
            days: new Set<string>(),
            hours: 0,
            ot: 0,
            absences: 0,
            lateDays: new Set<string>(),
            empId,
          };
        cur.absences += 1;
        byEmp.set(empId, cur);
      }
      const rows = Array.from(byEmp.values()).map((v) => {
        const row = {
          employee: v.employee,
          days_worked: v.days.size,
          total_hours: Number(v.hours.toFixed(2)),
          overtime_hours: Number(v.ot.toFixed(2)),
          absences: v.absences,
          late_days: v.lateDays.size,
          avg_hours: v.days.size
            ? Number((v.hours / v.days.size).toFixed(2))
            : 0,
        };
        return withMeta(row, null, v.empId);
      });
      return { data: rows, summary: {} };
    }
  }
}
