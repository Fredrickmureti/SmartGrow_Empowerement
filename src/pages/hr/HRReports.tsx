/**
 * HR Reports — country-agnostic, scope-aware analytics.
 *
 * Sections:
 *  - Headcount (department, position, location, branch)
 *  - Movement (hires / terminations / turnover)
 *  - Calendar (upcoming birthdays + work anniversaries)
 *  - Compensation snapshot (gated on viewEmployeePayroll)
 *
 * Country-localized statutory tables (PAYE/NSSF/NHIF/etc) belong under
 * Payroll, not here.
 */
import { useMemo, useState } from "react";
import { format, parseISO, subDays, subMonths, differenceInCalendarDays, setYear } from "date-fns";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";

import { useEmployees, type Employee } from "@/hooks/useEmployees";
import { useDepartments } from "@/hooks/useDepartments";
import { useJobPositions } from "@/hooks/useJobPositions";
import { useWorkLocations } from "@/hooks/useWorkLocations";
import { useCurrency } from "@/hooks/useCurrency";
import { useHrScope } from "@/hooks/hr/useHrScope";
import { useBranches } from "@/hooks/useBranches";
import { usePermissions } from "@/hooks/usePermissions";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { useReportExportContext } from "@/contexts/ReportContext";
import { HRAnalyticsPanel } from "@/components/hr/HRAnalyticsPanel";
import { FinalSettlementReconciliationCard } from "@/components/hr/FinalSettlementReconciliationCard";

function grossOf(e: Employee): number {
  const oa = (e as any).other_allowances as Record<string, unknown> | null | undefined;
  const other = oa
    ? Object.values(oa).reduce<number>((a, b) => a + (Number(b) || 0), 0)
    : 0;
  return (e.basic_salary || 0) + (e.housing_allowance || 0) + (e.transport_allowance || 0) + other;
}

function GroupCard({ title, rows }: { title: string; rows: { name: string; count: number }[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-1.5">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data.</p>
        ) : rows.slice(0, 10).map((r) => (
          <div key={r.name} className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="truncate pr-2">{r.name}</span>
              <span className="font-medium">{r.count}</span>
            </div>
            <div className="h-1.5 bg-muted rounded">
              <div className="h-full bg-primary rounded" style={{ width: `${(r.count / total) * 100}%` }} />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold mt-1">{value}</div>
        {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
      </CardContent>
    </Card>
  );
}

export default function HRReports() {
  const { employees, isLoading } = useEmployees();
  const { activeDepartments } = useDepartments();
  const { activePositions } = useJobPositions();
  const { activeLocations } = useWorkLocations();
  const { formatCurrency } = useCurrency();
  const { scopeLabel } = useHrScope();
  const { branches } = useBranches();
  const { can } = usePermissions();
  const { enrichExportConfig } = useReportExportContext();
  const [period, setPeriod] = useState("12");

  const months = parseInt(period);
  const cutoff = useMemo(() => subMonths(new Date(), months), [months]);
  const today = new Date();
  const in30 = subDays(today, -30);

  const active = employees.filter((e) => e.is_active);
  const inactive = employees.filter((e) => !e.is_active);

  // Headcount groupings
  const groupBy = (key: (e: Employee) => string | null | undefined, fallback = "Unassigned") => {
    const m = new Map<string, number>();
    active.forEach((e) => {
      const k = key(e) || fallback;
      m.set(k, (m.get(k) || 0) + 1);
    });
    return Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  };
  const byDepartment = groupBy((e) => e.department_name);
  const byPosition = groupBy((e) => activePositions.find((p) => p.id === (e as any).job_position_id)?.name || e.position);
  const byLocation = groupBy((e) => activeLocations.find((l) => l.id === (e as any).work_location_id)?.name);
  const branchNameById = useMemo(() => {
    const m = new Map<string, string>();
    branches.forEach((b: any) => m.set(b.id, b.name));
    return m;
  }, [branches]);
  const byBranch = groupBy((e) => {
    const bid = (e as any).branch_id;
    return bid ? branchNameById.get(bid) || "Unknown branch" : "Unassigned";
  });

  // Movement
  const hires = employees.filter((e) => e.hire_date && parseISO(e.hire_date) >= cutoff);
  const terms = inactive.filter((e) => e.termination_date && parseISO(e.termination_date) >= cutoff);
  const avgHc = active.length || 1;
  const turnover = ((terms.length / avgHc) * 100).toFixed(1);

  // Calendar
  const upcomingBirthdays = active
    .filter((e) => (e as any).date_of_birth)
    .map((e) => {
      const dob = parseISO((e as any).date_of_birth);
      const next = setYear(dob, today.getFullYear());
      const adj = next < today ? setYear(dob, today.getFullYear() + 1) : next;
      return { e, when: adj, days: differenceInCalendarDays(adj, today) };
    })
    .filter((x) => x.days >= 0 && x.days <= 30)
    .sort((a, b) => a.days - b.days);

  const upcomingAnniversaries = active
    .filter((e) => e.hire_date)
    .map((e) => {
      const hd = parseISO(e.hire_date);
      const next = setYear(hd, today.getFullYear());
      const adj = next < today ? setYear(hd, today.getFullYear() + 1) : next;
      return { e, when: adj, days: differenceInCalendarDays(adj, today), years: today.getFullYear() - hd.getFullYear() + (next < today ? 1 : 0) };
    })
    .filter((x) => x.days >= 0 && x.days <= 30 && x.years > 0)
    .sort((a, b) => a.days - b.days);

  // Compensation
  const canSeeComp = can("viewEmployeePayroll");
  const totalGross = active.reduce((s, e) => s + grossOf(e), 0);
  const avgGross = active.length ? totalGross / active.length : 0;

  const exportConfig = (): ExportConfig => ({
    title: "HR Report",
    subtitle: scopeLabel,
    dateRange: `Last ${months} months · As of ${format(today, "MMM d, yyyy")}`,
    columns: [
      { key: "section", header: "Section", width: 18 },
      { key: "label", header: "Label", width: 28 },
      { key: "value", header: "Value", width: 14, align: "right" },
    ],
    rows: [
      { section: "Movement", label: "Hires", value: hires.length },
      { section: "Movement", label: "Terminations", value: terms.length },
      { section: "Movement", label: "Turnover %", value: turnover },
      { section: "Headcount", label: "Active", value: active.length },
      { section: "Headcount", label: "Inactive", value: inactive.length },
      ...(canSeeComp
        ? [
            { section: "Compensation", label: "Total monthly gross", value: totalGross },
            { section: "Compensation", label: "Average gross", value: Math.round(avgGross) },
          ]
        : []),
    ],
    sheetName: "HR Report",
  });

  if (isLoading) {
    return (
      <>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">HR Reports</h1>
            <p className="text-sm text-muted-foreground">{scopeLabel}</p>
          </div>
          <div className="action-buttons flex items-center gap-2">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="3">Last 3 months</SelectItem>
                <SelectItem value="6">Last 6 months</SelectItem>
                <SelectItem value="12">Last 12 months</SelectItem>
                <SelectItem value="24">Last 24 months</SelectItem>
              </SelectContent>
            </Select>
            <ReportExportButtons getExportConfig={() => enrichExportConfig(exportConfig())} compact />
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Active" value={String(active.length)} />
          <Stat label="Inactive" value={String(inactive.length)} />
          <Stat label={`Hires · ${months}mo`} value={String(hires.length)} />
          <Stat label="Turnover" value={`${turnover}%`} hint={`${terms.length} terminations`} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <GroupCard title="Headcount by department" rows={byDepartment} />
          <GroupCard title="Headcount by job position" rows={byPosition} />
          <GroupCard title="Headcount by work location" rows={byLocation} />
          <GroupCard title="Headcount by branch" rows={byBranch} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Upcoming birthdays · 30 days</CardTitle></CardHeader>
            <CardContent>
              {upcomingBirthdays.length === 0 ? (
                <p className="text-sm text-muted-foreground">None in the next 30 days.</p>
              ) : (
                <ul className="space-y-1.5">
                  {upcomingBirthdays.slice(0, 8).map((x) => (
                    <li key={x.e.id} className="flex justify-between text-sm">
                      <span>{x.e.first_name} {x.e.last_name}</span>
                      <span className="text-muted-foreground">{format(x.when, "MMM d")} · in {x.days}d</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Work anniversaries · 30 days</CardTitle></CardHeader>
            <CardContent>
              {upcomingAnniversaries.length === 0 ? (
                <p className="text-sm text-muted-foreground">None in the next 30 days.</p>
              ) : (
                <ul className="space-y-1.5">
                  {upcomingAnniversaries.slice(0, 8).map((x) => (
                    <li key={x.e.id} className="flex justify-between text-sm">
                      <span>{x.e.first_name} {x.e.last_name}</span>
                      <span className="text-muted-foreground">{x.years}y · {format(x.when, "MMM d")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {canSeeComp && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Stat label="Total monthly gross" value={formatCurrency(totalGross)} />
            <Stat label="Average gross" value={formatCurrency(avgGross)} />
            <Stat label="Headcount included" value={String(active.length)} />
          </div>
        )}

        {/* Turn G — live analytics views */}
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Analytics</h2>
          <HRAnalyticsPanel />
          <FinalSettlementReconciliationCard />
        </div>
      </div>
    </>
  );
}
