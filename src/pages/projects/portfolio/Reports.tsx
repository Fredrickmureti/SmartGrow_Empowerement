/**
 * ProjectReports — the projects reporting workspace.
 *
 * Enterprise reporting contract (same as Finance / Payroll):
 *   1. The report is READ ON SCREEN. Choosing a report renders its actual
 *      rows in the canonical `ReportTable` under a `ReportSurface` masthead
 *      — no "open a PDF preview to find out what's in it".
 *   2. Export is an action ON the report being read, not the only way to
 *      see it: PDF / CSV / XLSX / print / email via `ReportExportButtons`.
 *   3. Screen and export are one document — both come from the same
 *      `render-report` server build (`format: "json"` for the screen,
 *      the same reportType + period for every export).
 *   4. Navigation state (report key + period) lives in the URL, so Back
 *      from a drill-down or a shared link restores the exact view.
 */
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { startOfYear, format } from "date-fns";
import { BarChart3, TrendingUp, Clock, FileText, Layers, Lock } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useProjects } from "@/hooks/projects";
import { usePermissions } from "@/hooks/usePermissions";

import {
  ReportSurface,
  ReportTable,
  toReportColumns,
  toReportRows,
  formatAccountingNumber,
  type ServerReportResult,
} from "@/design-system/reports";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { ReportEmptyState, type ReportEmptyStateDescriptor } from "@/components/reports/ReportEmptyState";
import { buildProjectReportConfig, type ProjectReportKey } from "@/components/projects/projectReportConfig";

type ReportKey = "portfolio" | "profitability" | "workload" | "timesheet" | "status" | "full";

const META: Record<
  ReportKey,
  {
    reportType: ProjectReportKey;
    title: string;
    desc: string;
    icon: typeof BarChart3;
    financeOnly?: boolean;
  }
> = {
  portfolio:     { reportType: "project_portfolio",        title: "Portfolio summary", desc: "Active projects, deadlines and progress.",                              icon: BarChart3 },
  profitability: { reportType: "project_profitability",    title: "Profitability",     desc: "Per-project revenue, cost and margin for the period.",                  icon: TrendingUp, financeOnly: true },
  workload:      { reportType: "project_workload",         title: "Workload",          desc: "Hours by project, billable vs non-billable.",                           icon: Clock },
  timesheet:     { reportType: "project_timesheet_detail", title: "Timesheet detail",  desc: "Line-level timesheets with employee, project, hours and billable flag.", icon: FileText },
  status:        { reportType: "project_status",            title: "Project status",    desc: "Latest status update per project.",                                     icon: BarChart3 },
  full:          { reportType: "project_full_export",       title: "Full export",       desc: "Every project with budget, actuals, milestones and task counts.",        icon: Layers, financeOnly: true },
};

const REPORT_KEYS = Object.keys(META) as ReportKey[];

function isReportKey(v: string | null): v is ReportKey {
  return !!v && (REPORT_KEYS as string[]).includes(v);
}

export default function ProjectReports() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { projects } = useProjects();
  const { can } = usePermissions();
  const canFinancials = can("manageProjectFinancials");
  const baseCurrency = currentBusiness?.base_currency ?? "";

  const [params, setParams] = useSearchParams();

  const defaultFrom = useMemo(() => format(startOfYear(new Date()), "yyyy-MM-dd"), []);
  const defaultTo = useMemo(() => format(new Date(), "yyyy-MM-dd"), []);

  const urlReport = params.get("report");
  const activeKey: ReportKey = isReportKey(urlReport) ? urlReport : "portfolio";
  const dateFrom = params.get("from") || defaultFrom;
  const dateTo = params.get("to") || defaultTo;

  const setScope = useCallback(
    (patch: Record<string, string>, replace = false) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      setParams(next, { replace });
    },
    [params, setParams],
  );

  const visibleReports = REPORT_KEYS.filter((k) => !META[k].financeOnly || canFinancials);
  const effectiveKey = visibleReports.includes(activeKey) ? activeKey : "portfolio";
  const meta = META[effectiveKey];

  // ---- KPI band (unchanged semantics, period-aware) --------------------
  const { data: kpis } = useQuery({
    queryKey: ["project-report-kpis", currentOrg?.id, currentBusiness?.id, dateFrom, dateTo, canFinancials, projects.length],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      if (!canFinancials) return { revenue: 0, cost: 0, hours: 0 };
      const ids = projects.map((p) => p.id);
      const safe = ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"];
      const bizId = currentBusiness?.id ?? null;
      let rQ = supabase.from("project_revenue_entries").select("amount").in("project_id", safe).gte("posted_at", dateFrom).lte("posted_at", `${dateTo}T23:59:59`);
      if (bizId) rQ = rQ.eq("business_id", bizId);
      let cQ = supabase.from("project_cost_entries").select("amount").in("project_id", safe).gte("posted_at", dateFrom).lte("posted_at", `${dateTo}T23:59:59`);
      if (bizId) cQ = cQ.eq("business_id", bizId);
      let tQ = supabase.from("timesheets").select("hours").eq("organization_id", currentOrg!.id).gte("date", dateFrom).lte("date", dateTo);
      if (bizId) tQ = tQ.eq("business_id", bizId);
      const [r, c, t] = await Promise.all([rQ, cQ, tQ]);
      const sum = (rows: { amount?: number | null; hours?: number | null }[] | null, key: "amount" | "hours") =>
        (rows ?? []).reduce((s, x) => s + Number(x[key] ?? 0), 0);
      return {
        revenue: sum(r.data as never, "amount"),
        cost: sum(c.data as never, "amount"),
        hours: sum(t.data as never, "hours"),
      };
    },
  });

  // ---- The report itself, server-built, read on screen ------------------
  const {
    data: result,
    isLoading,
    error,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["project-report", meta.reportType, currentOrg?.id, currentBusiness?.id, dateFrom, dateTo],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<ServerReportResult> => {
      const { data, error } = await supabase.functions.invoke("render-report", {
        body: {
          reportType: meta.reportType,
          organizationId: currentOrg!.id,
          businessId: currentBusiness?.id,
          dateFrom,
          dateTo,
          format: "json",
          filters: {},
        },
      });
      if (error) throw error;
      return data as ServerReportResult;
    },
  });

  const columns = useMemo(() => toReportColumns(result?.columns), [result?.columns]);
  const rows = useMemo(() => toReportRows(result?.data, columns), [result?.data, columns]);

  const getExportConfig = useCallback(
    () =>
      buildProjectReportConfig({
        reportType: meta.reportType,
        projectId: "*",
        organizationId: currentOrg?.id,
        businessId: currentBusiness?.id,

        dateFrom,
        dateTo,
        title: meta.title,
        subtitle: meta.desc,
        currency: baseCurrency,
      }),
    [meta, currentOrg?.id, currentBusiness?.id, dateFrom, dateTo, baseCurrency],
  );

  const emptyState: ReportEmptyStateDescriptor | undefined = (() => {
    if (isLoading || error) return undefined;
    if (rows.length > 0 && columns.length === 0) {
      return {
        kind: "missing_presentation",
        message: `"${meta.reportType}" returned ${rows.length} row(s) but no column layout resolved, so nothing can be rendered. This is a report-definition defect, not an empty period.`,
      };
    }
    if (rows.length > 0) return undefined;
    return {
      kind: "no_data",
      message: `No rows for ${dateFrom} to ${dateTo}. Widen the period, or check that projects exist for the active business.`,
    };
  })();

  const money = (n: number | null | undefined) =>
    n == null ? "—" : formatAccountingNumber(n, baseCurrency);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Project Reports</h1>
          <p className="text-muted-foreground">
            Read the report on screen, then export or print the exact same document.
          </p>
        </div>
        <ReportExportButtons getExportConfig={getExportConfig} reportSubtype={meta.reportType} />
      </div>

      {/* Report switcher — sibling reports in this domain */}
      <div className="flex flex-wrap gap-2">
        {visibleReports.map((k) => {
          const m = META[k];
          const Icon = m.icon;
          const active = k === effectiveKey;
          return (
            <Button
              key={k}
              variant={active ? "default" : "outline"}
              size="sm"
              onClick={() => setScope({ report: k })}
              className={cn(active && "shadow-sm")}
            >
              <Icon className="mr-2 h-4 w-4" />
              {m.title}
            </Button>
          );
        })}
      </div>

      {/* Period */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <div className="space-y-1">
            <Label htmlFor="report-from" className="text-xs">From</Label>
            <Input
              id="report-from"
              type="date"
              className="w-[170px]"
              value={dateFrom}
              onChange={(e) => setScope({ from: e.target.value }, true)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="report-to" className="text-xs">To</Label>
            <Input
              id="report-to"
              type="date"
              className="w-[170px]"
              value={dateTo}
              onChange={(e) => setScope({ to: e.target.value }, true)}
            />
          </div>
          <Badge variant="outline" className="mb-1">
            {isLoading ? "Loading…" : `${rows.length} row${rows.length === 1 ? "" : "s"}`}
          </Badge>
          {dataUpdatedAt > 0 && (
            <span className="mb-1.5 text-xs text-muted-foreground">
              Generated {format(new Date(dataUpdatedAt), "d MMM yyyy HH:mm")}
            </span>
          )}
        </CardContent>
      </Card>

      {/* KPI band */}
      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: "Revenue", value: money(kpis?.revenue), icon: TrendingUp, gated: !canFinancials },
          { label: "Cost", value: money(kpis?.cost), icon: BarChart3, gated: !canFinancials },
          { label: "Hours", value: kpis ? kpis.hours.toFixed(1) : null, icon: Clock, gated: false },
        ].map((kpi) => {
          const Icon = kpi.icon;
          return (
            <Card key={kpi.label}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{kpi.label}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                {kpi.gated ? (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" /> Permission required
                  </div>
                ) : kpi.value == null ? (
                  <Skeleton className="h-7 w-28" />
                ) : (
                  <div className="text-2xl font-bold">{kpi.value}</div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* The report */}
      <ReportSurface
        title={meta.title}
        dateRange={`${format(new Date(dateFrom), "d MMM yyyy")} – ${format(new Date(dateTo), "d MMM yyyy")}`}
        subtitle={meta.desc}
        profile={effectiveKey === "profitability" || effectiveKey === "full" ? "financial" : "operational"}
      >
        {isLoading ? (
          <div className="space-y-2 py-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : error ? (
          <p className="py-8 text-center text-sm text-destructive">
            {(error as Error).message || "The report could not be generated."}
          </p>
        ) : emptyState ? (
          <ReportEmptyState descriptor={emptyState} />
        ) : (
          <ReportTable columns={columns} rows={rows} currency={baseCurrency} />
        )}
      </ReportSurface>
    </div>
  );
}
