/**
 * AttendanceReports — analytical buckets.
 *
 * Late arrivals, missing checkouts, overtime, payroll-ready hours.
 * Branch-scoped; CSV/Excel/PDF export via ReportExportButtons.
 */
import { useState, useMemo, useEffect, useRef } from "react";
import {
  format,
  startOfMonth,
  endOfMonth,
  subMonths,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  differenceInHours,
  differenceInCalendarDays,
} from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertTriangle, Clock, Lock, CheckCircle2, Hourglass, UserX, FileBarChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAttendance } from "@/hooks/useAttendance";
import { useOrganization } from "@/hooks/useOrganization";
import { useAttendanceSettings } from "@/hooks/hr/useAttendanceSettings";
import { useEmployees } from "@/hooks/useEmployees";
import { useQuery } from "@tanstack/react-query";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { supabase } from "@/integrations/supabase/client";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AttendancePatternStrip } from "@/components/attendance/AttendancePatternStrip";
import {
  EmployeeDayDrawer,
  type DayDrawerTarget,
} from "@/components/attendance/EmployeeDayDrawer";
import type { AttendanceRecord } from "@/hooks/useAttendance";
import { SavedViewMenu } from "@/components/attendance/SavedViewMenu";
import { useAttendanceSavedViews } from "@/hooks/hr/useAttendanceSavedViews";
import { Switch } from "@/components/ui/switch";

type RangePreset = "this_week" | "this_month" | "last_month";

export default function AttendanceReports() {
  const [preset, setPreset] = useState<RangePreset>("this_month");
  const today = new Date();
  const range = {
    this_week: {
      from: format(startOfWeek(today, { weekStartsOn: 1 }), "yyyy-MM-dd"),
      to: format(endOfWeek(today, { weekStartsOn: 1 }), "yyyy-MM-dd"),
    },
    this_month: {
      from: format(startOfMonth(today), "yyyy-MM-dd"),
      to: format(endOfMonth(today), "yyyy-MM-dd"),
    },
    last_month: {
      from: format(startOfMonth(subMonths(today, 1)), "yyyy-MM-dd"),
      to: format(endOfMonth(subMonths(today, 1)), "yyyy-MM-dd"),
    },
  }[preset];

  const { records, isLoading } = useAttendance(range);
  const { currentOrg } = useOrganization();
  const { settings } = useAttendanceSettings();
  const { activeEmployees } = useEmployees();
  const { currentBusiness } = useBusinesses();
  const { branches } = useBranches();

  // Page-level filters (in addition to the global branch context).
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [hideAcked, setHideAcked] = useState(false);

  // Canonical detail view — every row opens the same drawer.
  const [drawerTarget, setDrawerTarget] = useState<DayDrawerTarget | null>(null);
  const openDrawer = (r: AttendanceRecord) => {
    setDrawerTarget({
      record: r,
      employeeName: r.employee
        ? `${r.employee.first_name} ${r.employee.last_name}`
        : "Unknown",
      employeeNumber: r.employee?.employee_number,
      branchName: r.branch_id
        ? branches.find((b) => b.id === r.branch_id)?.name ?? null
        : null,
    });
  };

  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const e of activeEmployees as any[]) {
      if (e.department_name) set.add(e.department_name);
      else if (e.department) set.add(e.department);
    }
    return Array.from(set).sort();
  }, [activeEmployees]);

  const empDeptName = (employee_id: string): string => {
    const e = (activeEmployees as any[]).find((x) => x.id === employee_id);
    return e?.department_name ?? e?.department ?? "—";
  };
  const branchName = (branch_id: string | null | undefined): string => {
    if (!branch_id) return "—";
    return branches.find((b) => b.id === branch_id)?.name ?? "—";
  };

  const staleHours = settings?.auto_checkout_after_hours ?? 16;

  // Work schedules in scope (used for "Absent vs scheduled")
  const { data: schedules = [] } = useQuery({
    queryKey: ["work-schedules-in-scope", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("work_schedules")
        .select("id, work_days")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true);
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      const { data } = await q;
      return data || [];
    },
    enabled: !!currentOrg?.id,
  });

  // Apply page filters before bucketing.
  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      if (employeeFilter !== "all" && r.employee_id !== employeeFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (departmentFilter !== "all" && empDeptName(r.employee_id) !== departmentFilter) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, employeeFilter, statusFilter, departmentFilter, activeEmployees]);

  const late = filteredRecords.filter((r) => r.status === "late" || (r.late_minutes ?? 0) > 0);
  const missingCheckout = filteredRecords.filter((r) => r.clock_in && !r.clock_out);
  const overtime = filteredRecords.filter((r) => (r.overtime_hours ?? 0) > 0);
  const payrollReady = filteredRecords.filter(
    (r) => r.clock_out && r.correction_status !== "pending" && !r.is_locked,
  );
  const locked = filteredRecords.filter((r) => r.is_locked);

  // Stale: open session past auto_checkout_after_hours
  const now = new Date();
  const stale = missingCheckout.filter(
    (r) => r.clock_in && differenceInHours(now, new Date(r.clock_in)) >= staleHours,
  );

  // A5b — when "Hide acknowledged" is on, drop rows whose anomaly_ack_codes
  // already cover the relevant exception. Uses the runtime column added in
  // migration 20260608113607.
  const isAcked = (r: any, codes: string[]) => {
    const ack: string[] = Array.isArray(r.anomaly_ack_codes) ? r.anomaly_ack_codes : [];
    return codes.every((c) => ack.includes(c));
  };
  const lateVisible = hideAcked ? late.filter((r) => !isAcked(r, ["late"])) : late;
  const missingVisible = hideAcked
    ? missingCheckout.filter((r) => !isAcked(r, ["missing_out"]))
    : missingCheckout;
  const staleVisible = hideAcked
    ? stale.filter((r) => !isAcked(r, ["long_session"]))
    : stale;

  // A1c — saved views for Reports.
  const currentFilters = useMemo(
    () => ({ preset, employeeFilter, departmentFilter, statusFilter, hideAcked }),
    [preset, employeeFilter, departmentFilter, statusFilter, hideAcked],
  );
  const applySavedFilters = (f: Record<string, unknown>) => {
    if (typeof f.preset === "string") setPreset(f.preset as RangePreset);
    if (typeof f.employeeFilter === "string") setEmployeeFilter(f.employeeFilter);
    if (typeof f.departmentFilter === "string") setDepartmentFilter(f.departmentFilter);
    if (typeof f.statusFilter === "string") setStatusFilter(f.statusFilter);
    if (typeof f.hideAcked === "boolean") setHideAcked(f.hideAcked);
  };
  const { defaultView } = useAttendanceSavedViews("reports");
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultRef.current) return;
    if (defaultView) {
      applySavedFilters(defaultView.filters);
      appliedDefaultRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultView]);

  // Absent vs scheduled: per (employee, working day), no row OR no clock_in,
  // excluding on_leave/holiday. Working day comes from each employee's
  // work schedule (work_days jsonb is { mon:true, tue:true, ... }).
  // If an employee has no work schedule, they are excluded — we don't fabricate.
  type AbsentRow = {
    id: string;
    attendance_date: string;
    employee?: { first_name: string; last_name: string };
    employee_id: string;
    status: string;
    clock_in: null;
    clock_out: null;
    worked_hours: number;
    late_minutes: number;
    overtime_hours: number;
    correction_status: string;
    is_locked: boolean;
  };
  const dowKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const recordIndex = new Map<string, typeof records[number]>();
  for (const r of filteredRecords) recordIndex.set(`${r.employee_id}|${r.attendance_date}`, r);
  const days = eachDayOfInterval({ start: new Date(range.from), end: new Date(range.to) });
  const absentRows: AbsentRow[] = [];
  const todayStr = format(new Date(), "yyyy-MM-dd");
  for (const emp of activeEmployees as any[]) {
    if (!emp.work_schedule_id) continue;
    if (employeeFilter !== "all" && emp.id !== employeeFilter) continue;
    if (departmentFilter !== "all" && (emp.department_name ?? emp.department) !== departmentFilter) continue;
    const sched = schedules.find((s: any) => s.id === emp.work_schedule_id) as any;
    if (!sched?.work_days) continue;
    for (const d of days) {
      const dateStr = format(d, "yyyy-MM-dd");
      if (dateStr > todayStr) continue;
      const dow = dowKeys[d.getDay()];
      if (!sched.work_days[dow]) continue;
      const r = recordIndex.get(`${emp.id}|${dateStr}`);
      if (r && (r.status === "on_leave" || r.status === "holiday" || r.clock_in)) continue;
      absentRows.push({
        id: `${emp.id}-${dateStr}`,
        attendance_date: dateStr,
        employee: { first_name: emp.first_name, last_name: emp.last_name },
        employee_id: emp.id,
        status: "absent",
        clock_in: null,
        clock_out: null,
        worked_hours: 0,
        late_minutes: 0,
        overtime_hours: 0,
        correction_status: "none",
        is_locked: false,
      });
    }
  }

  const empName = (r: typeof records[number]) =>
    r.employee ? `${r.employee.first_name} ${r.employee.last_name}` : "Unknown";

  const dateRangeStr = `${format(new Date(range.from), "MMM d, yyyy")} – ${format(new Date(range.to), "MMM d, yyyy")}`;

  /** Builds an ExportConfig bound to a registered report key — the
   *  unified `render-report` engine resolves columns/format from
   *  `_shared/reports/columnSpecs.ts` so attendance PDFs match Finance/Sales. */
  const buildReportConfig = (
    reportType: string,
    title: string,
    rows: any[],
    columns: ExportConfig["columns"],
  ): ExportConfig => ({
    title,
    reportType,
    dateRange: dateRangeStr,
    columns,
    rows,
    organizationId: currentOrg?.id,
  });

  // ── Row builders (one per registered report key) ──
  const dailyLogRows = filteredRecords.map((r) => ({
    employee: empName(r),
    employee_number: r.employee?.employee_number ?? "—",
    date: format(new Date(r.attendance_date), "yyyy-MM-dd"),
    clock_in: r.clock_in ? format(new Date(r.clock_in), "hh:mm a") : "—",
    clock_out: r.clock_out ? format(new Date(r.clock_out), "hh:mm a") : "—",
    worked_hours: r.worked_hours ?? 0,
    overtime_hours: r.overtime_hours ?? 0,
    status: r.status.replace("_", " "),
  }));
  const lateRows = late.map((r) => ({
    employee: empName(r),
    date: format(new Date(r.attendance_date), "yyyy-MM-dd"),
    clock_in: r.clock_in ? format(new Date(r.clock_in), "hh:mm a") : "—",
    late_minutes: r.late_minutes ?? 0,
    branch: branchName(r.branch_id),
  }));
  const absenceRows = absentRows.map((r) => ({
    employee: r.employee ? `${r.employee.first_name} ${r.employee.last_name}` : "Unknown",
    department: empDeptName(r.employee_id),
    date: r.attendance_date,
    reason: "No record",
  }));
  const payrollReadyRows = payrollReady.map((r) => ({
    employee: empName(r),
    date: format(new Date(r.attendance_date), "yyyy-MM-dd"),
    worked_hours: r.worked_hours ?? 0,
    overtime_hours: r.overtime_hours ?? 0,
    locked: r.is_locked ? "Yes" : "No",
  }));

  // Period summary — per-employee roll-up (Odoo-style "Attendance Analysis").
  const periodSummaryRows = useMemo(() => {
    const byEmp = new Map<
      string,
      { employee: string; days: Set<string>; hours: number; ot: number; absences: number; lateDays: Set<string> }
    >();
    for (const r of filteredRecords) {
      const k = r.employee_id;
      const cur = byEmp.get(k) ?? {
        employee: empName(r),
        days: new Set<string>(),
        hours: 0,
        ot: 0,
        absences: 0,
        lateDays: new Set<string>(),
      };
      if (r.clock_in) cur.days.add(r.attendance_date);
      cur.hours += Number(r.worked_hours ?? 0);
      cur.ot += Number(r.overtime_hours ?? 0);
      if (r.status === "late" || (r.late_minutes ?? 0) > 0) cur.lateDays.add(r.attendance_date);
      byEmp.set(k, cur);
    }
    for (const r of absentRows) {
      const k = r.employee_id;
      const cur = byEmp.get(k) ?? {
        employee: r.employee ? `${r.employee.first_name} ${r.employee.last_name}` : "Unknown",
        days: new Set<string>(),
        hours: 0,
        ot: 0,
        absences: 0,
        lateDays: new Set<string>(),
      };
      cur.absences += 1;
      byEmp.set(k, cur);
    }
    return Array.from(byEmp.values()).map((v) => ({
      employee: v.employee,
      days_worked: v.days.size,
      total_hours: Number(v.hours.toFixed(2)),
      overtime_hours: Number(v.ot.toFixed(2)),
      absences: v.absences,
      late_days: v.lateDays.size,
      avg_hours: v.days.size ? Number((v.hours / v.days.size).toFixed(2)) : 0,
    }));
  }, [filteredRecords, absentRows]);

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance Reports</h1>
          <p className="text-sm text-muted-foreground">
            Branded PDFs through the unified reporting engine — same masthead,
            footer hash, and audit log entry as Finance/Sales reports.
          </p>
        </div>
        <div className="action-buttons flex flex-wrap gap-2">
          <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="this_week">This Week</SelectItem>
              <SelectItem value="this_month">This Month</SelectItem>
              <SelectItem value="last_month">Last Month</SelectItem>
            </SelectContent>
          </Select>
          <ReportExportButtons
            getExportConfig={() =>
              buildReportConfig(
                "attendance_period_summary",
                "Attendance — Period Summary",
                periodSummaryRows,
                [
                  { key: "employee", header: "Employee", width: 32 },
                  { key: "days_worked", header: "Days", format: "number", width: 10, align: "right" },
                  { key: "total_hours", header: "Hours", format: "number", width: 12, align: "right" },
                  { key: "overtime_hours", header: "OT", format: "number", width: 10, align: "right" },
                  { key: "absences", header: "Absences", format: "number", width: 12, align: "right" },
                  { key: "late_days", header: "Late", format: "number", width: 10, align: "right" },
                  { key: "avg_hours", header: "Avg/Day", format: "number", width: 12, align: "right" },
                ],
              )
            }
            formats={["pdf", "excel", "csv"]}
          />
          <SavedViewMenu
            scope="reports"
            currentFilters={currentFilters}
            onApply={applySavedFilters}
          />
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4 grid gap-3 grid-cols-1 sm:grid-cols-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Employee</label>
            <Select value={employeeFilter} onValueChange={setEmployeeFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all">All employees</SelectItem>
                {(activeEmployees as any[]).map((e) => (
                  <SelectItem key={e.id} value={e.id}>{e.first_name} {e.last_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Department</label>
            <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="present">Present</SelectItem>
                <SelectItem value="late">Late</SelectItem>
                <SelectItem value="absent">Absent</SelectItem>
                <SelectItem value="half_day">Half day</SelectItem>
                <SelectItem value="on_leave">On leave</SelectItem>
                <SelectItem value="holiday">Holiday</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="stats-grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryCard label="Late" value={late.length} icon={<AlertTriangle className="h-4 w-4 text-amber-500" />} />
        <SummaryCard label="Missing" value={missingCheckout.length} icon={<Clock className="h-4 w-4 text-red-500" />} />
        <SummaryCard label={`Stale (>${staleHours}h)`} value={stale.length} icon={<Hourglass className="h-4 w-4 text-orange-500" />} />
        <SummaryCard label="Absent" value={absentRows.length} icon={<UserX className="h-4 w-4 text-rose-500" />} />
        <SummaryCard label="Overtime" value={overtime.length} icon={<Clock className="h-4 w-4 text-blue-500" />} />
        <SummaryCard label="Payroll-ready" value={payrollReady.length} icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />} />
      </div>

      <AttendancePatternStrip currentRange={records} />

      <Tabs defaultValue="exceptions">
        <TabsList>
          <TabsTrigger value="exceptions">Exceptions</TabsTrigger>
          <TabsTrigger value="hours">Hours</TabsTrigger>
          <TabsTrigger value="summary">Summary</TabsTrigger>
        </TabsList>

        <TabsContent value="exceptions" className="mt-4 space-y-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={hideAcked} onCheckedChange={setHideAcked} />
            Hide acknowledged exceptions
          </label>
          <ExceptionsView
            late={lateVisible}
            missingCheckout={missingVisible}
            stale={staleVisible}
            absentRows={absentRows as any}
            empName={empName}
            isLoading={isLoading}
            staleHours={staleHours}
            openDrawer={openDrawer}
            buildReportConfig={buildReportConfig}
            lateRows={lateRows}
            dailyLogRows={dailyLogRows}
            missingCheckoutRecords={missingVisible}
            absenceRows={absenceRows}
          />
        </TabsContent>

        <TabsContent value="hours" className="mt-4 space-y-3">
          <HoursView
            overtime={overtime}
            payrollReady={payrollReady}
            locked={locked}
            empName={empName}
            isLoading={isLoading}
            openDrawer={openDrawer}
            buildReportConfig={buildReportConfig}
            payrollReadyRows={payrollReadyRows}
          />
        </TabsContent>

        <TabsContent value="summary" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <FileBarChart className="h-4 w-4 text-primary" />
                Period summary <span className="text-muted-foreground text-xs">({periodSummaryRows.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {periodSummaryRows.length === 0 ? (
                <EmptyHint
                  title="No employees in scope"
                  body="Try broadening the date range or clearing the employee filter."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead className="text-right">Days</TableHead>
                      <TableHead className="text-right">Hours</TableHead>
                      <TableHead className="text-right">OT</TableHead>
                      <TableHead className="text-right">Absences</TableHead>
                      <TableHead className="text-right">Late</TableHead>
                      <TableHead className="text-right">Avg/Day</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {periodSummaryRows.map((r) => (
                      <TableRow key={r.employee}>
                        <TableCell className="font-medium">{r.employee}</TableCell>
                        <TableCell className="text-right">{r.days_worked}</TableCell>
                        <TableCell className="text-right">{r.total_hours.toFixed(2)}</TableCell>
                        <TableCell className="text-right">{r.overtime_hours.toFixed(2)}</TableCell>
                        <TableCell className="text-right">{r.absences}</TableCell>
                        <TableCell className="text-right">{r.late_days}</TableCell>
                        <TableCell className="text-right">{r.avg_hours.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <EmployeeDayDrawer
        target={drawerTarget}
        open={!!drawerTarget}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
      />
    </div>
  );
}

/** Segmented bucket switcher inside Exceptions / Hours tabs. */
type Segment = { value: string; label: string; count: number };
function SegmentChips({
  value,
  onChange,
  segments,
}: {
  value: string;
  onChange: (v: string) => void;
  segments: Segment[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {segments.map((s) => {
        const active = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            onClick={() => onChange(s.value)}
            className={
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors " +
              (active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:bg-muted")
            }
          >
            {s.label}
            <span
              className={
                "tabular-nums text-[10px] rounded-full px-1.5 " +
                (active ? "bg-primary-foreground/20" : "bg-muted")
              }
            >
              {s.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ExceptionsView({
  late,
  missingCheckout,
  stale,
  absentRows,
  empName,
  isLoading,
  staleHours,
  openDrawer,
  buildReportConfig,
  lateRows,
  dailyLogRows,
  missingCheckoutRecords,
  absenceRows,
}: any) {
  const [seg, setSeg] = useState<"late" | "missing" | "stale" | "absent">("late");
  const segments: Segment[] = [
    { value: "late", label: "Late", count: late.length },
    { value: "missing", label: "Missing checkout", count: missingCheckout.length },
    { value: "stale", label: "Stale", count: stale.length },
    { value: "absent", label: "Absent", count: absentRows.length },
  ];

  return (
    <>
      <SegmentChips value={seg} onChange={(v) => setSeg(v as any)} segments={segments} />

      {seg === "late" && (
        <ReportSection
          onRowClick={openDrawer}
          title="Late arrivals"
          rows={late}
          loading={isLoading}
          empName={empName}
          extraColumn={{ header: "Late by", render: (r: any) => `${r.late_minutes ?? 0} min` }}
          exportConfig={() =>
            buildReportConfig("attendance_late_arrivals", "Attendance — Late Arrivals", lateRows, [
              { key: "employee", header: "Employee", width: 24 },
              { key: "date", header: "Date", width: 14 },
              { key: "clock_in", header: "Clock In", width: 14 },
              { key: "late_minutes", header: "Late (min)", format: "number", width: 14, align: "right" },
              { key: "branch", header: "Branch", width: 18 },
            ])
          }
        />
      )}
      {seg === "missing" && (
        <ReportSection
          onRowClick={openDrawer}
          title="Missing checkouts"
          rows={missingCheckout}
          loading={isLoading}
          empName={empName}
          extraColumn={{
            header: "Open since",
            render: (r: any) =>
              r.clock_in ? format(new Date(r.clock_in), "MMM d · hh:mm a") : "—",
          }}
          exportConfig={() =>
            buildReportConfig(
              "attendance_daily_log",
              "Attendance — Missing Checkouts",
              dailyLogRows.filter((_: any, i: number) => missingCheckoutRecords[i]),
              [
                { key: "employee", header: "Employee", width: 24 },
                { key: "employee_number", header: "Emp #", width: 12 },
                { key: "date", header: "Date", width: 14 },
                { key: "clock_in", header: "Clock In", width: 12 },
                { key: "clock_out", header: "Clock Out", width: 12 },
                { key: "worked_hours", header: "Hours", format: "number", width: 10, align: "right" },
                { key: "overtime_hours", header: "OT", format: "number", width: 10, align: "right" },
                { key: "status", header: "Status", width: 12 },
              ],
            )
          }
        />
      )}
      {seg === "stale" && (
        <ReportSection
          onRowClick={openDrawer}
          title={`Stale open sessions (>${staleHours}h)`}
          rows={stale}
          loading={isLoading}
          empName={empName}
          extraColumn={{
            header: "Open for",
            render: (r: any) =>
              r.clock_in ? `${differenceInHours(new Date(), new Date(r.clock_in))}h` : "—",
          }}
          exportConfig={() =>
            buildReportConfig(
              "attendance_daily_log",
              "Attendance — Stale Sessions",
              stale.map((r: any) => ({
                employee: empName(r),
                employee_number: r.employee?.employee_number ?? "—",
                date: format(new Date(r.attendance_date), "yyyy-MM-dd"),
                clock_in: r.clock_in ? format(new Date(r.clock_in), "hh:mm a") : "—",
                clock_out: "—",
                worked_hours: 0,
                overtime_hours: 0,
                status: `open ${differenceInCalendarDays(new Date(), new Date(r.clock_in!))}d`,
              })),
              [],
            )
          }
        />
      )}
      {seg === "absent" && (
        <ReportSection
          onRowClick={openDrawer}
          title="Absent vs scheduled"
          rows={absentRows as any}
          loading={isLoading}
          empName={empName}
          extraColumn={{
            header: "Scheduled day",
            render: (r: any) => format(new Date(r.attendance_date), "EEE, MMM d"),
          }}
          exportConfig={() =>
            buildReportConfig("attendance_absences", "Attendance — Absences vs Scheduled", absenceRows, [
              { key: "employee", header: "Employee", width: 24 },
              { key: "department", header: "Department", width: 18 },
              { key: "date", header: "Scheduled Day", width: 18 },
              { key: "reason", header: "Reason", width: 24 },
            ])
          }
        />
      )}
    </>
  );
}

function HoursView({
  overtime,
  payrollReady,
  locked,
  empName,
  isLoading,
  openDrawer,
  buildReportConfig,
  payrollReadyRows,
}: any) {
  const [seg, setSeg] = useState<"overtime" | "payroll" | "locked">("overtime");
  const segments: Segment[] = [
    { value: "overtime", label: "Overtime", count: overtime.length },
    { value: "payroll", label: "Payroll-ready", count: payrollReady.length },
    { value: "locked", label: "Locked", count: locked.length },
  ];

  return (
    <>
      <SegmentChips value={seg} onChange={(v) => setSeg(v as any)} segments={segments} />

      {seg === "overtime" && (
        <ReportSection
          onRowClick={openDrawer}
          title="Overtime"
          rows={overtime}
          loading={isLoading}
          empName={empName}
          extraColumn={{ header: "Overtime", render: (r: any) => `${(r.overtime_hours ?? 0).toFixed(2)} h` }}
          exportConfig={() =>
            buildReportConfig(
              "attendance_daily_log",
              "Attendance — Overtime",
              overtime.map((r: any) => ({
                employee: empName(r),
                employee_number: r.employee?.employee_number ?? "—",
                date: format(new Date(r.attendance_date), "yyyy-MM-dd"),
                clock_in: r.clock_in ? format(new Date(r.clock_in), "hh:mm a") : "—",
                clock_out: r.clock_out ? format(new Date(r.clock_out), "hh:mm a") : "—",
                worked_hours: r.worked_hours ?? 0,
                overtime_hours: r.overtime_hours ?? 0,
                status: r.status.replace("_", " "),
              })),
              [],
            )
          }
        />
      )}
      {seg === "payroll" && (
        <ReportSection
          onRowClick={openDrawer}
          title="Payroll-ready hours"
          rows={payrollReady}
          loading={isLoading}
          empName={empName}
          extraColumn={{ header: "Hours", render: (r: any) => `${(r.worked_hours ?? 0).toFixed(2)}` }}
          statusBadge={(r: any) =>
            r.is_locked ? (
              <Badge variant="secondary">
                <Lock className="h-3 w-3 mr-1" /> Locked
              </Badge>
            ) : null
          }
          exportConfig={() =>
            buildReportConfig("attendance_payroll_ready", "Attendance — Payroll-Ready Hours", payrollReadyRows, [
              { key: "employee", header: "Employee", width: 24 },
              { key: "date", header: "Date", width: 14 },
              { key: "worked_hours", header: "Hours", format: "number", width: 12, align: "right" },
              { key: "overtime_hours", header: "OT", format: "number", width: 12, align: "right" },
              { key: "locked", header: "Locked", width: 12 },
            ])
          }
        />
      )}
      {seg === "locked" && (
        <ReportSection
          onRowClick={openDrawer}
          title="Locked by payroll"
          rows={locked}
          loading={false}
          empName={empName}
          extraColumn={{ header: "Hours", render: (r: any) => `${(r.worked_hours ?? 0).toFixed(2)}` }}
          exportConfig={() =>
            buildReportConfig(
              "attendance_payroll_ready",
              "Attendance — Locked Records",
              locked.map((r: any) => ({
                employee: empName(r),
                date: format(new Date(r.attendance_date), "yyyy-MM-dd"),
                worked_hours: r.worked_hours ?? 0,
                overtime_hours: r.overtime_hours ?? 0,
                locked: "Yes",
              })),
              [],
            )
          }
        />
      )}
    </>
  );
}

function EmptyHint({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center px-4">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground mt-1">{body}</p>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

function ReportSection({
  title,
  rows,
  loading,
  empName,
  extraColumn,
  statusBadge,
  exportConfig,
  onRowClick,
}: {
  title: string;
  rows: any[];
  loading: boolean;
  empName: (r: any) => string;
  extraColumn: { header: string; render: (r: any) => React.ReactNode };
  statusBadge?: (r: any) => React.ReactNode;
  exportConfig: () => ExportConfig;
  onRowClick?: (r: any) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          {title} <span className="text-muted-foreground text-xs">({rows.length})</span>
        </CardTitle>
        {rows.length > 0 && (
          <ReportExportButtons
            getExportConfig={exportConfig}
            formats={["excel", "csv", "pdf"]}
            compact
          />
        )}
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground p-6">No records.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>{extraColumn.header}</TableHead>
                {statusBadge && <TableHead></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.id}
                  className={onRowClick ? "cursor-pointer hover:bg-muted/50" : undefined}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                >
                  <TableCell className="font-medium">{empName(r)}</TableCell>
                  <TableCell>
                    {format(new Date(r.attendance_date), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell>{extraColumn.render(r)}</TableCell>
                  {statusBadge && <TableCell>{statusBadge(r)}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
