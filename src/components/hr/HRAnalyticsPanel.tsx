/**
 * HRAnalyticsPanel (Turn G) — reads the four pre-existing analytics views
 * and renders four cards: headcount mix, turnover, payroll cost by dept
 * for the latest run, and open leave liability.
 *
 * Drop-in panel used by HRDashboard (top) and HRReports (Analytics section).
 */
import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import {
  useHeadcountSnapshot,
  useTurnover12m,
  usePayrollCostByDepartment,
  useLeaveLiabilityOpen,
} from "@/hooks/useHRAnalytics";
import { useCurrency } from "@/hooks/useCurrency";
import { useDepartments } from "@/hooks/useDepartments";

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 bg-muted rounded">
      <div className="h-full bg-primary rounded" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function HRAnalyticsPanel() {
  const { data: headcount = [], isLoading: hcLoading } = useHeadcountSnapshot();
  const { data: turnover = [], isLoading: toLoading } = useTurnover12m();
  const { data: payrollCost = [], isLoading: pcLoading } = usePayrollCostByDepartment(500);
  const { data: leaveLiab = [], isLoading: llLoading } = useLeaveLiabilityOpen();
  const { formatCurrency } = useCurrency();
  const { departments } = useDepartments();
  const departmentName = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of departments) m.set(d.id, d.name);
    return (id?: string | null) => (id ? m.get(id) ?? "Unknown department" : "Unassigned");
  }, [departments]);

  // Aggregate headcount (across departments).
  const totals = useMemo(() => {
    return headcount.reduce(
      (acc, r) => {
        acc.total += r.total_count;
        acc.active += r.active_count;
        acc.full_time += r.full_time_count;
        acc.part_time += r.part_time_count;
        acc.contract += r.contract_count;
        return acc;
      },
      { total: 0, active: 0, full_time: 0, part_time: 0, contract: 0 },
    );
  }, [headcount]);

  const turnoverOverall = useMemo(() => {
    if (turnover.length === 0) return { pct: 0, hires: 0, terms: 0, active: 0 };
    const hires = turnover.reduce((s, r) => s + r.hires_12m, 0);
    const terms = turnover.reduce((s, r) => s + r.terminations_12m, 0);
    const active = turnover.reduce((s, r) => s + r.active_now, 0);
    return { pct: active > 0 ? (terms * 100) / active : 0, hires, terms, active };
  }, [turnover]);

  // Latest run cost-by-dept.
  const latestRunCost = useMemo(() => {
    if (payrollCost.length === 0) return null;
    const latest = [...payrollCost].sort((a, b) => b.pay_period_end.localeCompare(a.pay_period_end))[0];
    const rows = payrollCost.filter((r) => r.payroll_run_id === latest.payroll_run_id);
    const maxGross = Math.max(...rows.map((r) => r.total_gross), 1);
    return { latest, rows, maxGross };
  }, [payrollCost]);

  const leaveSummary = useMemo(() => {
    const byType = new Map<string, { name: string; days: number; amount: number }>();
    for (const r of leaveLiab) {
      const key = r.leave_type_id;
      const cur = byType.get(key) ?? { name: r.leave_type_name ?? "—", days: 0, amount: 0 };
      cur.days += r.days_open;
      cur.amount += r.liability_amount;
      byType.set(key, cur);
    }
    return [...byType.values()].sort((a, b) => b.amount - a.amount);
  }, [leaveLiab]);

  const turnoverByDept = useMemo(() => {
    return [...turnover]
      .filter((r) => r.active_now > 0)
      .sort((a, b) => b.turnover_pct - a.turnover_pct)
      .slice(0, 6);
  }, [turnover]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Headcount mix */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Headcount mix</CardTitle>
          <CardDescription>Active workforce, broken down by employment type</CardDescription>
        </CardHeader>
        <CardContent>
          {hcLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : totals.total === 0 ? (
            <p className="text-sm text-muted-foreground">No headcount data.</p>
          ) : (
            <div className="grid grid-cols-3 gap-3 text-center">
              <Stat label="Active" value={totals.active} />
              <Stat label="Full-time" value={totals.full_time} />
              <Stat label="Part-time" value={totals.part_time} />
              <Stat label="Contract" value={totals.contract} />
              <Stat label="Total" value={totals.total} />
              <Stat label="Departments" value={headcount.filter((r) => r.department_id).length} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Turnover */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Turnover (rolling 12m)</CardTitle>
          <CardDescription>Hires, exits and turnover rate over the past 12 months</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {toLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 text-center">
                <Stat label="Hires" value={turnoverOverall.hires} />
                <Stat label="Exits" value={turnoverOverall.terms} />
                <Stat label="Rate" value={`${turnoverOverall.pct.toFixed(1)}%`} />
              </div>
              {turnoverByDept.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Top by department</p>
                  {turnoverByDept.map((r) => (
                    <div key={`${r.department_id ?? "none"}`} className="text-sm">
                      <div className="flex justify-between">
                        <span className="truncate pr-2">{departmentName(r.department_id)}</span>
                        <span className="font-medium">{r.turnover_pct.toFixed(1)}%</span>
                      </div>
                      <Bar value={r.turnover_pct} max={100} />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Payroll cost by department, latest run */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payroll cost by department</CardTitle>
          <CardDescription>
            Most recent posted payroll run
            {latestRunCost ? ` · ${latestRunCost.latest.payroll_number ?? latestRunCost.latest.payroll_run_id.slice(0, 8)}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {pcLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : !latestRunCost ? (
            <p className="text-sm text-muted-foreground">No posted runs yet.</p>
          ) : (
            latestRunCost.rows.map((r) => (
              <div key={`${r.payroll_run_id}-${r.department_id ?? "x"}`} className="text-sm">
                <div className="flex justify-between">
                  <span className="truncate pr-2">{r.department_name ?? "Unassigned"} · {r.employee_count} emp</span>
                  <span className="font-medium">{formatCurrency(r.total_gross)}</span>
                </div>
                <Bar value={r.total_gross} max={latestRunCost.maxGross} />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Deductions {formatCurrency(r.total_deductions)}</span>
                  <span>Net {formatCurrency(r.total_net)}</span>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Open leave liability */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open leave liability</CardTitle>
          <CardDescription>Accrued, unused leave balances by leave type</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {llLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : leaveSummary.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open balances.</p>
          ) : (
            leaveSummary.slice(0, 8).map((r) => (
              <div key={r.name} className="flex items-center justify-between text-sm">
                <div className="truncate pr-2 flex items-center gap-2">
                  <Badge variant="outline">{r.name}</Badge>
                  <span className="text-muted-foreground">{r.days.toFixed(1)} d</span>
                </div>
                <span className="font-medium">{formatCurrency(r.amount)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md bg-muted/40 p-2">
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
