/**
 * Payroll Overview — KPIs + quick actions + blockers.
 *
 * Replaces the stats-row from the legacy Payroll.tsx monolith. Pulls
 * counts from the existing usePayroll hook plus payroll_run_issues for
 * outstanding blockers across all in-flight runs.
 */
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Calculator, FileText, DollarSign, AlertTriangle, ArrowRight,
  ClipboardCheck, Clock, Banknote,
} from "lucide-react";
import { usePayroll } from "@/hooks/usePayroll";
import { useEmployees } from "@/hooks/useEmployees";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/usePermissions";
import { format } from "date-fns";
import { PayrollGlReadinessBanner } from "@/components/payroll/PayrollGlReadinessBanner";
import { useDashboardComposition } from "@/hooks/useDashboardComposition";

export default function PayrollOverview() {
  const { payrollRuns, isLoading } = usePayroll();
  const { activeEmployees, calculateGrossPay } = useEmployees();
  const { formatCurrency } = useCurrency();
  const { can } = usePermissions();
  const composition = useDashboardComposition();

  const drafts = payrollRuns.filter((r) => r.status === "draft");
  const processing = payrollRuns.filter((r) => r.status === "processed");
  const pendingApproval = payrollRuns.filter((r) => r.status === "approved");
  const posted = payrollRuns.filter((r) => r.status === "posted");
  const totalMonthlyPayroll = activeEmployees.reduce((s, e) => s + calculateGrossPay(e), 0);
  const lastRun = payrollRuns[0];
  const canSeeMoney = can("viewSalaryDetails");

  return (
    <div className="space-y-6">
      <PayrollGlReadinessBanner />
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Payroll Overview</h1>
          <p className="text-sm text-muted-foreground">
            Snapshot of payroll readiness, in-flight runs, and quick actions.
          </p>
        </div>
        {can("runPayroll") && (
          <Button asChild>
            <Link to="/hr/payroll/runs?action=create">
              <Calculator className="h-4 w-4 mr-2" /> New Payroll Run
            </Link>
          </Button>
        )}
      </div>

      {composition.allowsWidget("payroll.kpis") && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard icon={FileText} label="Active Employees" value={activeEmployees.length} />
          <KpiCard icon={DollarSign} label="Est. Monthly Payroll" value={canSeeMoney ? formatCurrency(totalMonthlyPayroll) : "Hidden"} />
          <KpiCard icon={ClipboardCheck} label="Pending Approval" value={pendingApproval.length} />
          <KpiCard icon={Banknote} label={`Posted · Drafts ${drafts.length} · Processing ${processing.length}`} value={posted.length} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Recent Runs</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : payrollRuns.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payroll runs yet.</p>
            ) : (
              <ul className="divide-y">
                {payrollRuns.slice(0, 5).map((run) => (
                  <li key={run.id} className="flex items-center justify-between py-2">
                    <div>
                      <Link
                        to={`/hr/payroll/runs/${run.id}`}
                        className="font-medium text-sm hover:underline"
                      >
                        {run.payroll_number}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(run.pay_period_start), "MMM d")} – {format(new Date(run.pay_period_end), "MMM d, yyyy")} · {run.employee_count} employees
                      </p>
                    </div>
                    <Badge variant="outline" className="capitalize">{run.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
            <div className="pt-3">
              <Button asChild variant="ghost" size="sm">
                <Link to="/hr/payroll/runs">View all runs <ArrowRight className="h-3 w-3 ml-1" /></Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Quick checks
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <QuickLink to="/hr/payroll/readiness" label="Employee payroll readiness" hint="Contracts, schedules, bank info" icon={ClipboardCheck} />
            <QuickLink to="/hr/payroll/work-entries" label="Review work entries" hint="Attendance + leave rollups" icon={Clock} />
            <QuickLink to="/hr/payroll/configuration" label="Payroll configuration" hint="Schedules, rules, accounts" icon={Calculator} />
            {drafts.length > 0 && lastRun && (
              <Link
                to={`/hr/payroll/runs/${lastRun.id}`}
                className="block rounded-md border bg-amber-50 dark:bg-amber-950/20 p-2"
              >
                <div className="text-xs font-medium">Draft run pending</div>
                <div className="text-xs text-muted-foreground">{lastRun.payroll_number} — review and approve</div>
              </Link>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

function QuickLink({ to, label, hint, icon: Icon }: { to: string; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <Link to={to} className="flex items-start gap-2 rounded-md border p-2 hover:bg-muted/50">
      <Icon className="h-4 w-4 mt-0.5 text-muted-foreground" />
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
    </Link>
  );
}
