import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Users, CalendarOff, Calculator, ArrowRight, Clock, UserCheck, TrendingUp, AlertTriangle, CheckCircle2, DollarSign, X, Sparkles, Settings, UserPlus } from "lucide-react";
import { useEmployees } from "@/hooks/useEmployees";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { useCurrency } from "@/hooks/useCurrency";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { format, startOfWeek, endOfWeek, startOfDay, endOfDay } from "date-fns";
import { formatYmdInTz } from "@/lib/businessTime";
import { getWeekStart } from "@/lib/datetime/weekStart";

import { useDashboardComposition } from "@/hooks/useDashboardComposition";
import { TerminationPayoutReconciliationCard } from "@/components/hr/TerminationPayoutReconciliationCard";
import { HRAnalyticsPanel } from "@/components/hr/HRAnalyticsPanel";
import { ProbationEndingCard } from "@/components/hr/ProbationEndingCard";
import { ModuleInboxCard, ModuleInboxStrip } from "@/components/hr/ModuleInboxCard";


export default function HRDashboard() {
  const composition = useDashboardComposition();
  const navigate = useNavigate();
  const { employees, isLoading } = useEmployees();
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [showWelcome, setShowWelcome] = useState(true);

  const activeEmployees = employees.filter(e => e.is_active);
  const inactiveEmployees = employees.filter(e => !e.is_active);
  const departments = [...new Set(activeEmployees.map(e => e.department).filter(Boolean))];
  const totalPayroll = activeEmployees.reduce((s, e) => s + (e.basic_salary || 0) + (e.housing_allowance || 0) + (e.transport_allowance || 0), 0);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recentHires = activeEmployees.filter(e => new Date(e.hire_date) >= thirtyDaysAgo);

  const fullTime = activeEmployees.filter(e => e.employment_type === "full_time").length;

  const getHRDashboardExportConfig = (): ExportConfig => ({
    title: "HR Dashboard Summary",
    companyName: currentOrg?.name || "",
    columns: [
      { key: "metric", header: "Metric", width: 30 },
      { key: "value", header: "Value", width: 20, align: "right" },
    ],
    rows: [
      { metric: "Active Employees", value: activeEmployees.length },
      { metric: "Inactive Employees", value: inactiveEmployees.length },
      { metric: "Departments", value: departments.length },
      { metric: "Full-Time", value: fullTime },
      { metric: "Part-Time", value: partTime },
      { metric: "Contract", value: contract },
      { metric: "Monthly Gross Payroll", value: totalPayroll, _isSubtotal: true },
      { metric: "Recent Hires (30 days)", value: recentHires.length },
      { metric: "On Leave Today", value: leaveStats?.onLeaveToday ?? 0 },
      { metric: "Pending Leave Requests", value: leaveStats?.pending ?? 0 },
      { metric: "Clocked In Today", value: attendanceStats?.clockedIn ?? 0 },
      ...departments.map(dept => ({
        metric: `Dept: ${dept}`,
        value: activeEmployees.filter(e => e.department === dept).length,
      })),
    ],
    sheetName: "HR Summary",
  });
  const partTime = activeEmployees.filter(e => e.employment_type === "part_time").length;
  const contract = activeEmployees.filter(e => e.employment_type === "contract").length;

  // Live leave requests this week
  const weekStart = format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd");
  const weekEnd = format(endOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd");

  const { data: leaveStats } = useQuery({
    queryKey: ["hr-dashboard-leave", currentOrg?.id, currentBusiness?.id, weekStart],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return { pending: 0, approvedThisWeek: 0, onLeaveToday: 0 };
      const today = format(new Date(), "yyyy-MM-dd");

      const [pendingRes, approvedRes, onLeaveRes] = await Promise.all([
        supabase.from("leave_requests").select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id).eq("business_id", currentBusiness.id).eq("status", "pending"),
        supabase.from("leave_requests").select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id).eq("business_id", currentBusiness.id).eq("status", "approved")
          .gte("created_at", weekStart).lte("created_at", weekEnd),
        supabase.from("leave_requests").select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id).eq("business_id", currentBusiness.id).eq("status", "approved")
          .lte("start_date", today).gte("end_date", today),
      ]);

      return {
        pending: pendingRes.count || 0,
        approvedThisWeek: approvedRes.count || 0,
        onLeaveToday: onLeaveRes.count || 0,
      };
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  // Today's attendance — Odoo-aligned:
  //   • "checked in now" = OPEN sessions (clock_out IS NULL), regardless of
  //     attendance_date, so overnight shifts stay visible after midnight.
  //   • "attended today" = rows whose business-local attendance_date is today.
  // Both must use the business timezone for "today" or Africa/Nairobi etc.
  // will mis-bucket sessions stamped near UTC midnight.
  const todayStr = formatYmdInTz(new Date(), currentBusiness?.timezone);
  const { data: attendanceStats } = useQuery({
    queryKey: ["hr-dashboard-attendance", currentOrg?.id, currentBusiness?.id, todayStr],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return { clockedIn: 0, attendedToday: 0, absent: 0 };
      const [openRes, todayRes] = await Promise.all([
        supabase.from("attendance").select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id).eq("business_id", currentBusiness.id)
          .is("clock_out", null).not("clock_in", "is", null),
        supabase.from("attendance").select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id).eq("business_id", currentBusiness.id)
          .eq("attendance_date", todayStr).not("clock_in", "is", null),
      ]);
      const clockedIn = openRes.count || 0;
      const attendedToday = todayRes.count || 0;
      return {
        clockedIn,
        attendedToday,
        absent: Math.max(0, activeEmployees.length - clockedIn),
      };
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id && activeEmployees.length > 0,
    refetchInterval: 60_000,
  });


  // Latest payroll run
  const { data: latestPayroll } = useQuery({
    queryKey: ["hr-dashboard-payroll", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return null;
      const { data } = await (supabase as any).from("payroll_runs").select("payroll_number, status, total_gross, total_net, pay_period_start, pay_period_end, employee_count")
        .eq("organization_id", currentOrg.id).eq("business_id", currentBusiness.id).order("created_at", { ascending: false }).limit(1).single();
      return data;
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  if (isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  const isFirstRun = activeEmployees.length === 0 && inactiveEmployees.length === 0;

  return (
    <div className="space-y-6">
      {/* Welcome banner for first-time setup */}
      {isFirstRun && showWelcome && (
        <Card className="border-primary/30 bg-gradient-to-r from-primary/5 to-primary/10">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                <div className="rounded-full bg-primary/10 p-2.5 mt-0.5">
                  <Sparkles className="h-5 w-5 text-primary" />
                </div>
                <div className="space-y-3">
                  <div>
                    <h3 className="font-semibold text-base">Welcome to HR & Payroll!</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Your module is ready. Here's how to get started:
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="default" onClick={() => navigate("/hr/employees")} className="gap-1.5">
                      <UserPlus className="h-3.5 w-3.5" />
                      Add your first employee
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => navigate("/hr/configuration")} className="gap-1.5">
                      <Settings className="h-3.5 w-3.5" />
                      Configure leave & payroll
                    </Button>
                  </div>
                </div>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setShowWelcome(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="page-title">HR Overview</h1>
          <p className="text-sm text-muted-foreground mt-1">Workforce summary, departments, and payroll at a glance</p>
        </div>
        <ReportExportButtons getExportConfig={getHRDashboardExportConfig} />
      </div>

      {/* Unified Inbox strip — Attendance / Timesheets / Time-off.
          Collapses to a single "All clear" row when every queue is empty. */}
      <ModuleInboxStrip />




      {/* Alerts */}
      <div className="flex flex-wrap gap-3">
        {recentHires.length > 0 && (
          <Card className="border-primary/30 bg-primary/5 flex-1 min-w-[250px]">
            <CardContent className="p-4 flex items-center gap-3">
              <TrendingUp className="h-5 w-5 text-primary shrink-0" />
              <div>
                <p className="text-sm font-medium text-primary">{recentHires.length} new hire{recentHires.length !== 1 ? "s" : ""} (30d)</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {recentHires.slice(0, 4).map(e => (
                    <Badge key={e.id} variant="secondary" className="text-xs">{e.first_name} {e.last_name}</Badge>
                  ))}
                  {recentHires.length > 4 && <Badge variant="outline" className="text-xs">+{recentHires.length - 4}</Badge>}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
        {(leaveStats?.pending || 0) > 0 && (
          <Card className="border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 flex-1 min-w-[200px]">
            <CardContent className="p-4 flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">{leaveStats!.pending} pending leave request{leaveStats!.pending !== 1 ? "s" : ""}</p>
                <Button variant="link" size="sm" className="p-0 h-auto text-xs" onClick={() => navigate("/hr/leave")}>Review now →</Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* KPI Cards — role-gated; cashier/sales hidden */}
      {composition.allowsWidget("hr.kpis") && (
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-amber-500" onClick={() => navigate("/hr/employees")}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Active Employees</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{activeEmployees.length}</div>
            <p className="text-xs text-muted-foreground mt-1">{inactiveEmployees.length > 0 ? `${inactiveEmployees.length} inactive` : "all active"}</p>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-blue-500" onClick={() => navigate("/hr/attendance")}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Checked in now</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{attendanceStats?.clockedIn ?? "—"}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {attendanceStats
                ? `${attendanceStats.attendedToday} attended today · ${attendanceStats.absent} not in`
                : "loading..."}
            </p>
          </CardContent>
        </Card>


        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-purple-500" onClick={() => navigate("/hr/leave")}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">On Leave Today</CardTitle>
              <CalendarOff className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{leaveStats?.onLeaveToday ?? "—"}</div>
            <p className="text-xs text-muted-foreground mt-1">{leaveStats?.approvedThisWeek || 0} approved this week</p>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-emerald-500" onClick={() => navigate("/hr/payroll")}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Monthly Payroll</CardTitle>
              <Calculator className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{formatCurrency(totalPayroll)}</div>
            <p className="text-xs text-muted-foreground mt-1">gross monthly total</p>
          </CardContent>
        </Card>
      </div>
      )}

      {/* Latest Payroll Run — payroll summary widget; executive/accountant/operations only */}
      {composition.allowsWidget("hr.payrollSummary") && latestPayroll && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Latest Payroll Run</CardTitle>
              <Badge variant={latestPayroll.status === "paid" ? "default" : "secondary"}>{latestPayroll.status}</Badge>
            </div>
            <CardDescription>
              {latestPayroll.payroll_number} · {format(new Date(latestPayroll.pay_period_start), "MMM d")} - {format(new Date(latestPayroll.pay_period_end), "MMM d, yyyy")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-3 rounded-lg bg-muted/50">
                <div className="text-lg font-bold">{latestPayroll.employee_count}</div>
                <div className="text-xs text-muted-foreground">Employees</div>
              </div>
              <div className="text-center p-3 rounded-lg bg-muted/50">
                <div className="text-lg font-bold">{formatCurrency(latestPayroll.total_gross)}</div>
                <div className="text-xs text-muted-foreground">Gross</div>
              </div>
              <div className="text-center p-3 rounded-lg bg-muted/50">
                <div className="text-lg font-bold">{formatCurrency(latestPayroll.total_net)}</div>
                <div className="text-xs text-muted-foreground">Net</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Turn G — analytics views panel */}
      <HRAnalyticsPanel />
      {/* Turn K — probation ending soon */}
      <ProbationEndingCard />

      {/* Wave 2.5 — termination payout reconciliation */}
      {composition.allowsWidget("hr.payrollSummary") && (
        <TerminationPayoutReconciliationCard />
      )}

      {/* Department Breakdown */}
      {departments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Department Breakdown</CardTitle>
            <CardDescription>Headcount by department</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {departments.map(dept => {
                const count = activeEmployees.filter(e => e.department === dept).length;
                return (
                  <div key={dept} className="text-center p-3 rounded-lg bg-muted/50">
                    <div className="text-lg font-bold">{count}</div>
                    <div className="text-xs text-muted-foreground truncate">{dept}</div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Employment Types */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Employment Types</CardTitle>
          <CardDescription>Workforce composition</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center p-3 rounded-lg bg-muted/50">
              <div className="text-2xl font-bold">{fullTime}</div>
              <div className="text-xs text-muted-foreground mt-1">Full-Time</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted/50">
              <div className="text-2xl font-bold">{partTime}</div>
              <div className="text-xs text-muted-foreground mt-1">Part-Time</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted/50">
              <div className="text-2xl font-bold">{contract}</div>
              <div className="text-xs text-muted-foreground mt-1">Contract</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card>
        <CardHeader><CardTitle className="text-base">Quick Actions</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/hr/employees")}>Employees <ArrowRight className="h-3 w-3 ml-1" /></Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/hr/employees/departments")}>Departments <ArrowRight className="h-3 w-3 ml-1" /></Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/hr/leave")}>Leave <ArrowRight className="h-3 w-3 ml-1" /></Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/hr/payroll")}>Payroll <ArrowRight className="h-3 w-3 ml-1" /></Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/hr/payroll?action=create")}>Run Payroll <ArrowRight className="h-3 w-3 ml-1" /></Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/hr/attendance")}>Attendance <ArrowRight className="h-3 w-3 ml-1" /></Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/hr/configuration")}>HR Settings <ArrowRight className="h-3 w-3 ml-1" /></Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
