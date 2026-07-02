/**
 * Attendance — Manager command center (Today).
 *
 * Working surface for managing other people:
 *   • Header: branch context, approvals chip, Manual Entry, Open Kiosk
 *   • Interactive KPI strip — tiles filter the roster; "Checked in now"
 *     opens the live-presence popover
 *   • Roster: status chips, multi-select with bulk lock, anomaly badges,
 *     row click opens EmployeeDayDrawer
 *   • Timesheet consistency (collapsible) at the bottom
 *
 * Self-clock lives on `/me/attendance`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  format,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
} from "date-fns";
import {
  ChevronDown,
  Clock,
  ExternalLink,
  Inbox,
  Loader2,
  Lock,
  Plus,
  Radio,
  Search,
} from "lucide-react";

import { useAttendance, type AttendanceRecord } from "@/hooks/useAttendance";
import { useEmployees } from "@/hooks/useEmployees";
import { usePermissions } from "@/hooks/usePermissions";
import { useBranches } from "@/hooks/useBranches";
import { useHrScope } from "@/hooks/hr/useHrScope";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { todayInBusinessTz, ymdToLocalNoon } from "@/lib/businessTime";
import { useAttendanceSettings } from "@/hooks/hr/useAttendanceSettings";
import { useAttendanceInboxCounts } from "@/hooks/hr/useAttendanceInboxCounts";
import { useAttendanceDaySummary } from "@/hooks/hr/useAttendanceDaySummary";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AttendanceFormShell } from "@/components/attendance/_shared/AttendanceFormShell";
import {
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { AttendanceKpiStrip } from "@/components/attendance/AttendanceKpiStrip";
import { LivePresenceCard } from "@/components/attendance/LivePresenceCard";
import { AttendanceReviewCard } from "@/components/attendance/AttendanceReviewCard";
import { TimesheetConsistencyCard } from "@/components/attendance/TimesheetConsistencyCard";
import { BranchesGlanceStrip } from "@/components/attendance/BranchesGlanceStrip";
import { ClosePeriodDialog } from "@/components/attendance/ClosePeriodDialog";
import {
  StatusFilterChips,
  type RosterFilter,
} from "@/components/attendance/StatusFilterChips";
import { AnomalyBadge } from "@/components/attendance/AnomalyBadge";
import {
  EmployeeDayDrawer,
  type DayDrawerTarget,
} from "@/components/attendance/EmployeeDayDrawer";
import { EmployeeTrendDrawer } from "@/components/attendance/EmployeeTrendDrawer";
import { SavedViewMenu } from "@/components/attendance/SavedViewMenu";
import { useAttendanceSavedViews } from "@/hooks/hr/useAttendanceSavedViews";
import { detectAnomalies } from "@/lib/attendance/anomalies";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";

type DateRangePreset = "today" | "this_week" | "this_month";

export default function Attendance() {
  // B1: honour ?scope=team from the redirected /hr/attendance/team URL so the
  // existing "My team" chip starts active without remounting the page.
  const initialTeamOnly =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("scope") === "team";
  const [preset, setPreset] = useState<DateRangePreset>("today");
  const [showManualDialog, setShowManualDialog] = useState(false);
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [consistencyOpen, setConsistencyOpen] = useState(false);
  const [filter, setFilter] = useState<RosterFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerTarget, setDrawerTarget] = useState<DayDrawerTarget | null>(null);
  const [trendTarget, setTrendTarget] = useState<
    { employeeId: string; employeeName: string } | null
  >(null);
  const [presenceOpen, setPresenceOpen] = useState(false);
  const [myTeamOnly, setMyTeamOnly] = useState(initialTeamOnly);
  const { can } = usePermissions();
  const { directReports, isManager } = useCurrentEmployee();
  const directReportIds = useMemo(
    () => new Set(directReports.map((r) => r.id)),
    [directReports],
  );

  const { currentBusiness } = useBusinesses();
  // Build "today/week/month" boundaries in the BUSINESS timezone so they
  // line up with how the backend stamps attendance_date. Without this,
  // a clock-in between business-local midnight and UTC midnight falls
  // on a different calendar day in the dashboard query than in the row.
  const bizTz = currentBusiness?.timezone ?? null;
  const todayLocalYmd = todayInBusinessTz(bizTz);
  const todayLocal = ymdToLocalNoon(todayLocalYmd);
  const dateRange = {
    today: {
      from: todayLocalYmd,
      to: todayLocalYmd,
    },
    this_week: {
      from: format(startOfWeek(todayLocal, { weekStartsOn: 1 }), "yyyy-MM-dd"),
      to: format(endOfWeek(todayLocal, { weekStartsOn: 1 }), "yyyy-MM-dd"),
    },
    this_month: {
      from: format(startOfMonth(todayLocal), "yyyy-MM-dd"),
      to: format(endOfMonth(todayLocal), "yyyy-MM-dd"),
    },
  }[preset];

  const {
    records,
    isLoading,
    createAttendance,
    checkedInNow,
    openSessions,
    overnightOpenSessions,
  } = useAttendance(dateRange);


  const { activeEmployees } = useEmployees();
  const { currentOrg } = useOrganization();
  const { branches, currentBranch } = useBranches();
  const { settings } = useAttendanceSettings();
  const { counts: inboxCounts } = useAttendanceInboxCounts();
  const hrScope = useHrScope();

  const scopedEmployees = hrScope.isBranchRestricted
    ? activeEmployees.filter(
        (e: any) => e.branch_id && hrScope.branchIds.includes(e.branch_id),
      )
    : activeEmployees;

  // Further narrow by the active branch selector so "Present today" matches the
  // branch the user is looking at (Odoo-parity: branch is a soft scope on
  // analytics, while live presence stays company-wide via openSessions).
  const branchScopedEmployees = useMemo(() => {
    if (!currentBranch?.id) return scopedEmployees;
    return scopedEmployees.filter(
      (e: any) => !e.branch_id || e.branch_id === currentBranch.id,
    );
  }, [scopedEmployees, currentBranch?.id]);

  // Odoo-style derived metrics for the active business day. The headline
  // tiles and the filter chips both consume `summary` so the numbers and the
  // visible roster always agree.
  const summary = useAttendanceDaySummary({
    date: todayLocalYmd,
    records,
    scopedActiveEmployees: branchScopedEmployees as any,
  });

  // Per-branch headcount totals — fed into BranchesGlanceStrip so coverage
  // chips show "checkedIn / totalForBranch" rather than just live count.
  const totalsByBranch = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of scopedEmployees as any[]) {
      if (!e.branch_id) continue;
      m.set(e.branch_id, (m.get(e.branch_id) ?? 0) + 1);
    }
    return m;
  }, [scopedEmployees]);

  const [manualForm, setManualForm] = useState({
    employee_id: "",
    attendance_date: todayLocalYmd,
    clock_in: "09:00",
    clock_out: "17:00",
    status: "present" as string,
    notes: "",
  });

  // Unified employee-day view (only for the Today preset). Synthesizes a
  // pseudo-row for every expected employee with NO attendance line so that
  // Absent / On-leave / Holiday counts and the visible roster agree —
  // mirrors Odoo's "Attendances → By employee, by day" view.
  type DayRow =
    | { kind: "real"; record: AttendanceRecord; anomalies: ReturnType<typeof detectAnomalies> }
    | { kind: "synthetic"; employeeId: string; employee: any; pseudoStatus: "absent" | "on_leave" | "holiday"; anomalies: [] };

  const isTodayPreset = preset === "today";

  const dayRows: DayRow[] = useMemo(() => {
    const realRows: DayRow[] = records.map((r) => ({
      kind: "real" as const,
      record: r,
      anomalies: detectAnomalies(r, settings),
    }));
    if (!isTodayPreset) return realRows;

    const seen = new Set(
      records.filter((r) => r.attendance_date === todayLocalYmd).map((r) => r.employee_id),
    );
    const synth: DayRow[] = [];
    for (const emp of branchScopedEmployees as any[]) {
      if (seen.has(emp.id)) continue;
      const s = summary.statusFor(emp.id);
      if (s === "present" || s === "late") continue;
      synth.push({
        kind: "synthetic",
        employeeId: emp.id,
        employee: emp,
        pseudoStatus: s,
        anomalies: [],
      });
    }
    return [...realRows, ...synth];
  }, [records, settings, isTodayPreset, branchScopedEmployees, summary, todayLocalYmd]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return dayRows.filter((row) => {
      const empId = row.kind === "real" ? row.record.employee_id : row.employeeId;
      const emp = row.kind === "real" ? row.record.employee : row.employee;

      if (myTeamOnly && !directReportIds.has(empId)) return false;

      if (filter !== "all") {
        if (filter === "anomaly") {
          if (row.anomalies.length === 0) return false;
        } else if (filter === "present") {
          if (!summary.presentEmployeeIds.has(empId)) return false;
        } else if (filter === "late") {
          if (!summary.lateRecords.some((r) => r.employee_id === empId)) return false;
        } else if (filter === "absent") {
          if (row.kind === "real") {
            // A real row counts as absent only if it isn't present/late/leave/holiday.
            if (summary.presentEmployeeIds.has(empId)) return false;
            if (summary.onLeaveEmployeeIds.has(empId)) return false;
            if (summary.holidayEmployeeIds.has(empId)) return false;
          } else if (row.pseudoStatus !== "absent") return false;
        } else if (filter === "on_leave") {
          if (!summary.onLeaveEmployeeIds.has(empId)) return false;
        }
      }

      if (!q) return true;
      const name = emp ? `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.toLowerCase() : "";
      return (
        name.includes(q) ||
        (emp?.employee_number ?? "").toLowerCase().includes(q)
      );
    });
  }, [dayRows, filter, searchQuery, myTeamOnly, directReportIds, summary]);

  // Backwards-compat alias used by export/bulk handlers below (they only
  // touch real records — synthetic rows are filtered out).
  const filteredRecords = useMemo(
    () => filteredRows.filter((r): r is Extract<DayRow, { kind: "real" }> => r.kind === "real"),
    [filteredRows],
  );

  const filterCounts = useMemo(() => {
    const all = dayRows.length;
    const present = summary.presentCount;
    const late = summary.lateCount;
    const absent = summary.absentCount;
    const on_leave = summary.onLeaveCount;
    const anomaly = dayRows.reduce((n, r) => n + (r.anomalies.length ? 1 : 0), 0);
    return { all, present, late, absent, on_leave, anomaly };
  }, [dayRows, summary]);

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      present: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
      absent: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
      late: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
      half_day: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
      on_leave: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
      holiday: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300",
    };
    return (
      <Badge className={styles[status] || styles.present}>
        {status.replace("_", " ")}
      </Badge>
    );
  };

  const submitManualEntry = () => {
    const clockInDT = `${manualForm.attendance_date}T${manualForm.clock_in}:00`;
    const clockOutDT = manualForm.clock_out
      ? `${manualForm.attendance_date}T${manualForm.clock_out}:00`
      : null;
    createAttendance({
      employee_id: manualForm.employee_id,
      attendance_date: manualForm.attendance_date,
      clock_in: clockInDT,
      clock_out: clockOutDT,
      status: manualForm.status,
      notes: manualForm.notes || null,
    });
    setShowManualDialog(false);
  };

  const allVisibleSelected =
    filteredRecords.length > 0 && filteredRecords.every((r) => selected.has(r.record.id));
  const toggleAllVisible = () => {
    const next = new Set(selected);
    if (allVisibleSelected) filteredRecords.forEach((r) => next.delete(r.record.id));
    else filteredRecords.forEach((r) => next.add(r.record.id));
    setSelected(next);
  };
  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const clearSelection = () => setSelected(new Set());

  const queryClient = useQueryClient();
  const [bulkBusy, setBulkBusy] = useState(false);
  const invalidateAttendance = () => {
    queryClient.invalidateQueries({ queryKey: ["attendance"] });
    queryClient.invalidateQueries({ queryKey: ["attendance-status"] });
  };

  /** Force-close every selected row that is still open (clock_in set, clock_out null). */
  const runBulkCloseStale = async () => {
    const targets = filteredRecords
      .filter((r) => selected.has(r.record.id) && r.record.clock_in && !r.record.clock_out && !r.record.is_locked)
      .map((r) => r.record.id);
    if (targets.length === 0) {
      toast.info("No open sessions in your selection.");
      return;
    }
    if (!window.confirm(`Force-close ${targets.length} open session(s)? This is logged in audit.`)) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(
      targets.map((id) =>
        (supabase as any).rpc("attendance_admin_close_session", {
          _attendance_id: id,
          _clock_out: null,
          _reason: "Bulk close from Today roster",
        }),
      ),
    );
    setBulkBusy(false);
    const ok = results.filter((r) => r.status === "fulfilled" && !(r.value as any)?.error).length;
    const fail = results.length - ok;
    if (ok) toast.success(`Closed ${ok} session(s).`);
    if (fail) toast.error(`${fail} session(s) failed.`);
    clearSelection();
    invalidateAttendance();
  };

  /** Create an 'absent' record for selected employees/days that don't have one yet.
      Uses the existing attendance_admin_create RPC; rows that already exist are skipped via DB unique. */
  const runBulkMarkAbsent = async () => {
    // Distinct (employee_id, date) keys from selection that don't currently have a clock_in
    const targets = filteredRecords.filter(
      (r) => selected.has(r.record.id) && !r.record.clock_in && r.record.status !== "absent" && !r.record.is_locked,
    );
    if (targets.length === 0) {
      toast.info("Selection has no eligible rows (already absent, locked, or already clocked in).");
      return;
    }
    if (!window.confirm(`Mark ${targets.length} employee/day record(s) as absent?`)) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(
      targets.map((r) =>
        (supabase as any).rpc("attendance_admin_mark_absent", {
          _attendance_id: r.record.id,
          _reason: "Bulk marked absent from Today roster",
        }),
      ),
    );
    setBulkBusy(false);
    const ok = results.filter((r) => r.status === "fulfilled" && !(r.value as any)?.error).length;
    const fail = results.length - ok;
    if (ok) toast.success(`Marked ${ok} record(s) absent.`);
    if (fail) toast.error(`${fail} record(s) failed (may already exist).`);
    clearSelection();
    invalidateAttendance();
  };

  const branchLookup = (branch_id: string | null | undefined) =>
    branch_id ? branches.find((b) => b.id === branch_id)?.name ?? null : null;

  const openDrawer = (r: Extract<DayRow, { kind: "real" }>) => {
    // B1 / A4b: in My-Team scope, row click opens the 30-day trend drawer
    // instead of the day drawer — managers want pattern, not just today.
    if (myTeamOnly) {
      setTrendTarget({
        employeeId: r.record.employee_id,
        employeeName: r.record.employee
          ? `${r.record.employee.first_name} ${r.record.employee.last_name}`
          : "Employee",
      });
      return;
    }
    setDrawerTarget({
      record: r.record,
      employeeName: r.record.employee
        ? `${r.record.employee.first_name} ${r.record.employee.last_name}`
        : "Unknown",
      employeeNumber: r.record.employee?.employee_number,
      branchName: branchLookup(r.record.branch_id),
    });
  };

  // A1c: saved-views — current filter shape + apply handler.
  const currentFilters = useMemo(
    () => ({ preset, filter, searchQuery, myTeamOnly }),
    [preset, filter, searchQuery, myTeamOnly],
  );
  const applySavedFilters = (f: Record<string, unknown>) => {
    if (typeof f.preset === "string") setPreset(f.preset as DateRangePreset);
    if (typeof f.filter === "string") setFilter(f.filter as RosterFilter);
    if (typeof f.searchQuery === "string") setSearchQuery(f.searchQuery);
    if (typeof f.myTeamOnly === "boolean") setMyTeamOnly(f.myTeamOnly);
  };
  const { defaultView } = useAttendanceSavedViews("today");
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultRef.current) return;
    if (initialTeamOnly) {
      appliedDefaultRef.current = true;
      return;
    }
    if (defaultView) {
      applySavedFilters(defaultView.filters);
      appliedDefaultRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultView]);

  const scopeLabel = currentBranch?.name ?? "All branches";

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance</h1>
          <p className="text-sm text-muted-foreground">
            {scopeLabel} · live operations and today's roster
          </p>
        </div>
        <div className="action-buttons flex flex-wrap gap-2">
          {inboxCounts.total > 0 && (
            <Button asChild variant="outline" className="gap-2">
              <Link to="/hr/attendance/approvals">
                <Inbox className="h-4 w-4" />
                Approvals
                <Badge variant="destructive" className="h-5 px-1.5 text-xs">
                  {inboxCounts.total}
                </Badge>
              </Link>
            </Button>
          )}
          {can("manageAttendance") && (
            <Button onClick={() => setShowManualDialog(true)} variant="outline">
              <Plus className="h-4 w-4 mr-1" />
              Manual Entry
            </Button>
          )}
          {can("manageAttendance") && (
            <Button
              onClick={() => setShowCloseDialog(true)}
              variant="outline"
              title="Lock attendance rows in a date range so payroll can run on a stable dataset"
            >
              <Lock className="h-4 w-4 mr-1" />
              Close period
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => window.open("/kiosk/attendance", "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="h-4 w-4 mr-1" />
            Open Kiosk
          </Button>
        </div>
      </div>

      {/* KPI strip + presence popover */}
      <AttendanceKpiStrip
        checkedInNow={checkedInNow}
        totalEmployees={summary.expectedCount || activeEmployees.length}
        present={summary.presentCount}
        late={summary.lateCount}
        absent={summary.absentCount}
        onLeave={summary.onLeaveCount}
        value={filter}
        onChange={setFilter}
        onPresenceClick={() => setPresenceOpen(true)}
      />

      {/* Overnight carry-over notice — sessions that started before the
          current business day and are still open. Odoo-style: live presence
          must remain visible across midnight rollovers. */}
      {(overnightOpenSessions?.length ?? 0) > 0 && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <Radio className="h-4 w-4 shrink-0" />
          <span>
            {overnightOpenSessions!.length} overnight session
            {overnightOpenSessions!.length === 1 ? "" : "s"} still open from a previous day —
            <button
              type="button"
              className="underline ml-1"
              onClick={() => setPresenceOpen(true)}
            >
              view live presence
            </button>
          </span>
        </div>
      )}


      {/* Live presence popover (controlled, opened from KPI tile) */}
      <Popover open={presenceOpen} onOpenChange={setPresenceOpen}>
        <PopoverTrigger asChild>
          <span className="sr-only" aria-hidden />
        </PopoverTrigger>
        <PopoverContent
          className="w-[min(640px,calc(100vw-2rem))] p-0"
          align="start"
          side="bottom"
          sideOffset={4}
        >
          <div className="px-3 py-2 border-b flex items-center gap-2">
            <Radio className="h-3.5 w-3.5 text-emerald-500" />
            <span className="text-sm font-medium">Live presence</span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            <LivePresenceCard />
          </div>
        </PopoverContent>
      </Popover>

      {/* Risk-engine flagged rows (impossible travel, untrusted device, etc.) */}
      <AttendanceReviewCard />

      {/* Multi-branch coverage glance — hidden automatically when <2 branches */}
      <BranchesGlanceStrip records={records} totalsByBranch={totalsByBranch} />

      {/* Roster */}
      <Card>
        <div className="border-b p-3 sm:p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold">Roster</h2>
              <p className="text-xs text-muted-foreground">
                {format(new Date(dateRange.from), "MMM d, yyyy")}
                {dateRange.from !== dateRange.to
                  ? ` – ${format(new Date(dateRange.to), "MMM d, yyyy")}`
                  : ""}
              </p>
            </div>
            <div className="relative sm:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search employees…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            <Select value={preset} onValueChange={(v) => setPreset(v as DateRangePreset)}>
              <SelectTrigger className="w-[140px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="this_week">This week</SelectItem>
                <SelectItem value="this_month">This month</SelectItem>
              </SelectContent>
            </Select>
            <SavedViewMenu
              scope="today"
              currentFilters={currentFilters}
              onApply={applySavedFilters}
            />
            <ReportExportButtons
              getExportConfig={() =>
                ({
                  title: "Attendance Report",
                  reportType: "attendance_daily_log",
                  companyName: currentOrg?.name || undefined,
                  dateRange: `${format(new Date(dateRange.from), "MMM d, yyyy")} – ${format(new Date(dateRange.to), "MMM d, yyyy")}`,
                  columns: [
                    { key: "employee", header: "Employee", width: 22 },
                    { key: "employee_number", header: "Emp #", width: 12 },
                    { key: "date", header: "Date", width: 14 },
                    { key: "clock_in", header: "Clock In", width: 12 },
                    { key: "clock_out", header: "Clock Out", width: 12 },
                    { key: "worked_hours", header: "Worked Hours", format: "number", width: 12, align: "right" },
                    { key: "overtime_hours", header: "Overtime", format: "number", width: 10, align: "right" },
                    { key: "status", header: "Status", width: 10 },
                  ],
                  rows: filteredRecords.map(({ record: r }) => ({
                    employee: r.employee
                      ? `${r.employee.first_name} ${r.employee.last_name}`
                      : "Unknown",
                    employee_number: r.employee?.employee_number || "—",
                    date: format(new Date(r.attendance_date), "MMM d, yyyy"),
                    clock_in: r.clock_in ? format(new Date(r.clock_in), "hh:mm a") : "—",
                    clock_out: r.clock_out ? format(new Date(r.clock_out), "hh:mm a") : "—",
                    worked_hours: r.worked_hours ?? 0,
                    overtime_hours: r.overtime_hours ?? 0,
                    status: r.status.replace("_", " "),
                  })),
                  organizationId: currentOrg?.id,
                }) as ExportConfig
              }
              formats={["excel", "csv", "pdf"]}
              compact
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusFilterChips value={filter} onChange={setFilter} counts={filterCounts} />
              {isManager && directReportIds.size > 0 && (
                <button
                  type="button"
                  onClick={() => setMyTeamOnly((v) => !v)}
                  className={
                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors " +
                    (myTeamOnly
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:bg-muted")
                  }
                  title="Show only your direct reports"
                >
                  My team
                  <span
                    className={
                      "tabular-nums text-[10px] rounded-full px-1.5 " +
                      (myTeamOnly ? "bg-primary-foreground/20" : "bg-muted")
                    }
                  >
                    {directReportIds.size}
                  </span>
                </button>
              )}
            </div>
            {selected.size > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">{selected.size} selected</span>
                {can("manageAttendance") && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runBulkCloseStale()}
                      disabled={bulkBusy}
                    >
                      Close stale sessions
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runBulkMarkAbsent()}
                      disabled={bulkBusy}
                    >
                      Mark absent
                    </Button>
                  </>
                )}
                <Button size="sm" variant="ghost" onClick={clearSelection}>
                  Clear
                </Button>
              </div>
            )}
          </div>
        </div>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <Clock className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No attendance records</h3>
              <p className="text-muted-foreground text-sm">
                {filter === "all" && !myTeamOnly
                  ? "No records found for the selected period."
                  : `No rows match the current filters.`}
              </p>
              {(filter !== "all" || myTeamOnly || searchQuery) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4"
                  onClick={() => {
                    setFilter("all");
                    setMyTeamOnly(false);
                    setSearchQuery("");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <div className="table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allVisibleSelected}
                        onCheckedChange={toggleAllVisible}
                        aria-label="Select all visible"
                      />
                    </TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Clock In</TableHead>
                    <TableHead>Clock Out</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead className="text-right">OT</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Flags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.map((row) => {
                    if (row.kind === "synthetic") {
                      const emp = row.employee;
                      const empName = emp ? `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim() : "Unknown";
                      return (
                        <TableRow key={`synth-${row.employeeId}`} className="opacity-80">
                          <TableCell />
                          <TableCell className="font-medium">
                            {empName}
                            <div className="text-xs text-muted-foreground">
                              {emp?.employee_number}
                            </div>
                          </TableCell>
                          <TableCell>{format(new Date(todayLocalYmd), "MMM d, yyyy")}</TableCell>
                          <TableCell className="text-muted-foreground">—</TableCell>
                          <TableCell className="text-muted-foreground">—</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">0.0</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">0.0</TableCell>
                          <TableCell>{getStatusBadge(row.pseudoStatus)}</TableCell>
                          <TableCell />
                        </TableRow>
                      );
                    }
                    const r = row.record;
                    return (
                      <TableRow
                        key={r.id}
                        id={`roster-row-${r.employee_id}`}
                        data-employee-id={r.employee_id}
                        className="cursor-pointer scroll-mt-24 target:bg-accent/60"
                        onClick={() => openDrawer(row)}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selected.has(r.id)}
                            onCheckedChange={() => toggleRow(r.id)}
                            aria-label="Select row"
                          />
                        </TableCell>
                        <TableCell className="font-medium">
                          {r.employee
                            ? `${r.employee.first_name} ${r.employee.last_name}`
                            : "Unknown"}
                          <div className="text-xs text-muted-foreground">
                            {r.employee?.employee_number}
                          </div>
                        </TableCell>
                        <TableCell>{format(new Date(r.attendance_date), "MMM d, yyyy")}</TableCell>
                        <TableCell>
                          {r.clock_in ? format(new Date(r.clock_in), "hh:mm a") : "—"}
                        </TableCell>
                        <TableCell>
                          {r.clock_out
                            ? format(new Date(r.clock_out), "hh:mm a")
                            : r.clock_in
                              ? "Active"
                              : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {(r.worked_hours || 0).toFixed(1)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {(r.overtime_hours || 0).toFixed(1)}
                        </TableCell>
                        <TableCell>{getStatusBadge(r.status)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            {r.is_locked && (
                              <span title="Locked by payroll">
                                <Lock className="h-3 w-3 text-muted-foreground" />
                              </span>
                            )}
                            {r.correction_status !== "none" && (
                              <Badge
                                variant={
                                  r.correction_status === "approved"
                                    ? "default"
                                    : r.correction_status === "rejected"
                                      ? "destructive"
                                      : "secondary"
                                }
                                className="h-5 px-1.5 text-[10px]"
                              >
                                {r.correction_status}
                              </Badge>
                            )}
                            <AnomalyBadge
                              anomalies={row.anomalies}
                              compact
                              attendanceId={r.id}
                              ackedCodes={(r as any).anomaly_ack_codes ?? []}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Timesheet consistency (collapsible) */}
      <Collapsible open={consistencyOpen} onOpenChange={setConsistencyOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="w-full justify-between">
            <span className="text-sm font-medium">Timesheet consistency</span>
            <ChevronDown
              className={"h-4 w-4 transition-transform " + (consistencyOpen ? "rotate-180" : "")}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <TimesheetConsistencyCard from={dateRange.from} to={dateRange.to} />
        </CollapsibleContent>
      </Collapsible>

      {/* Day drawer */}
      <EmployeeDayDrawer
        target={drawerTarget}
        open={!!drawerTarget}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
      />

      {/* Trend drawer — opens for My-Team row clicks */}
      <EmployeeTrendDrawer
        employeeId={trendTarget?.employeeId ?? null}
        employeeName={trendTarget?.employeeName ?? ""}
        open={!!trendTarget}
        onOpenChange={(o) => !o && setTrendTarget(null)}
      />

      {/* Manual Entry sheet */}
      <AttendanceFormShell
        open={showManualDialog}
        onOpenChange={setShowManualDialog}
        entity="manual-attendance"
        submitDisabled={!manualForm.employee_id}
        submitLabel="Save"
        onSubmit={submitManualEntry}
      >
        <WorkflowSheetSection number={1} title="Employee" subtitle="Pick who this entry is for. Branch is inferred from the employee record.">
          <WorkflowField label="Employee" required>
            <Select
              value={manualForm.employee_id}
              onValueChange={(v) => setManualForm({ ...manualForm, employee_id: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select employee" />
              </SelectTrigger>
              <SelectContent>
                {scopedEmployees.map((emp) => (
                  <SelectItem key={emp.id} value={emp.id}>
                    {emp.first_name} {emp.last_name} ({emp.employee_number})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
          {(() => {
            const sel = activeEmployees.find((e) => e.id === manualForm.employee_id) as any;
            if (!sel) return null;
            const branchName = sel.branch_id
              ? (branches.find((b) => b.id === sel.branch_id)?.name ?? "Unknown branch")
              : "No branch";
            return (
              <p className="text-xs text-muted-foreground">
                This entry will be stamped to <span className="font-medium">{branchName}</span>.
              </p>
            );
          })()}
        </WorkflowSheetSection>

        <WorkflowSheetSection number={2} title="Time" subtitle="Clock-in is required; clock-out can be added later.">
          <WorkflowSheetGrid columns={3}>
            <WorkflowField label="Date" required>
              <Input
                type="date"
                value={manualForm.attendance_date}
                onChange={(e) =>
                  setManualForm({ ...manualForm, attendance_date: e.target.value })
                }
                required
              />
            </WorkflowField>
            <WorkflowField label="Clock in">
              <Input
                type="time"
                value={manualForm.clock_in}
                onChange={(e) => setManualForm({ ...manualForm, clock_in: e.target.value })}
              />
            </WorkflowField>
            <WorkflowField label="Clock out">
              <Input
                type="time"
                value={manualForm.clock_out}
                onChange={(e) => setManualForm({ ...manualForm, clock_out: e.target.value })}
              />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>

        <WorkflowSheetSection number={3} title="Classification" subtitle="Status and notes appear on the attendance ledger and audit log.">
          <WorkflowSheetGrid>
            <WorkflowField label="Status" required>
              <Select
                value={manualForm.status}
                onValueChange={(v) => setManualForm({ ...manualForm, status: v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="present">Present</SelectItem>
                  <SelectItem value="late">Late</SelectItem>
                  <SelectItem value="absent">Absent</SelectItem>
                  <SelectItem value="half_day">Half day</SelectItem>
                  <SelectItem value="on_leave">On leave</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Notes">
              <Input
                value={manualForm.notes}
                onChange={(e) => setManualForm({ ...manualForm, notes: e.target.value })}
                placeholder="Optional context for the audit trail"
              />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
      </AttendanceFormShell>

      {/* Period close — locks attendance for payroll cutoff */}
      <ClosePeriodDialog open={showCloseDialog} onOpenChange={setShowCloseDialog} />
    </div>
  );
}
