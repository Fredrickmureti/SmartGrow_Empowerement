/**
 * ProjectReports — preview-before-download via the canonical ReportPreviewDialog
 * (the same dialog Finance/Sales/Payroll use). All five `project_*` keys are
 * server-built by the unified `render-report` engine — no client-side row
 * assembly, no parallel PDF stack.
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useProjects } from "@/hooks/projects";
import { startOfYear, format } from "date-fns";
import { BarChart3, TrendingUp, Clock, FileText, Eye, Lock } from "lucide-react";
import { ReportPreviewDialog } from "@/components/reports/ReportPreviewDialog";
import { usePermissions } from "@/hooks/usePermissions";
import type { ExportConfig } from "@/services/reports/ReportExportService";

type ReportKey = "portfolio" | "profitability" | "workload" | "timesheet" | "status";

const META: Record<ReportKey, { reportType: string; title: string; desc: string; icon: typeof BarChart3; financeOnly?: boolean }> = {
  portfolio:     { reportType: "project_portfolio",        title: "Portfolio summary",  desc: "Active projects, deadlines and progress.",                              icon: BarChart3 },
  profitability: { reportType: "project_profitability",    title: "Profitability",      desc: "Per-project revenue, cost and margin (YTD).",                            icon: TrendingUp, financeOnly: true },
  workload:      { reportType: "project_workload",         title: "Workload",           desc: "Hours by project, billable vs non-billable.",                            icon: Clock },
  timesheet:     { reportType: "project_timesheet_detail", title: "Timesheet detail",   desc: "Line-level timesheets with employee, project, hours and billable flag.", icon: FileText },
  status:        { reportType: "project_status",           title: "Project status",     desc: "Latest status update per project.",                                      icon: BarChart3 },
};

export default function ProjectReports() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { projects } = useProjects();
  const { can } = usePermissions();
  const canFinancials = can("manageProjectFinancials");
  const baseCurrency = currentBusiness?.base_currency || "USD";

  const [revenueYtd, setRevenueYtd] = useState<number | null>(null);
  const [costYtd, setCostYtd] = useState<number | null>(null);
  const [hoursYtd, setHoursYtd] = useState<number | null>(null);
  const [openKey, setOpenKey] = useState<ReportKey | null>(null);

  const yearStart = useMemo(() => startOfYear(new Date()).toISOString(), []);
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);

  useEffect(() => {
    let alive = true;
    async function run() {
      if (!currentOrg) return;
      if (!canFinancials) {
        setRevenueYtd(0); setCostYtd(0); setHoursYtd(0);
        return;
      }
      const ids = projects.map((p) => p.id);
      const safe = ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"];
      const bizId = currentBusiness?.id ?? null;
      let rQ = supabase.from("project_revenue_entries").select("amount").in("project_id", safe).gte("posted_at", yearStart);
      if (bizId) rQ = rQ.eq("business_id", bizId);
      let cQ = supabase.from("project_cost_entries").select("amount").in("project_id", safe).gte("posted_at", yearStart);
      if (bizId) cQ = cQ.eq("business_id", bizId);
      let tQ = supabase.from("timesheets").select("hours").eq("organization_id", currentOrg.id).gte("date", yearStart.slice(0, 10));
      if (bizId) tQ = tQ.eq("business_id", bizId);
      const [r, c, t] = await Promise.all([rQ, cQ, tQ]);
      if (!alive) return;
      setRevenueYtd((r.data ?? []).reduce((s, x: { amount: number | null }) => s + Number(x.amount ?? 0), 0));
      setCostYtd((c.data ?? []).reduce((s, x: { amount: number | null }) => s + Number(x.amount ?? 0), 0));
      setHoursYtd((t.data ?? []).reduce((s, x: { hours: number | null }) => s + Number(x.hours ?? 0), 0));
    }
    void run();
    return () => { alive = false; };
  }, [currentOrg?.id, currentBusiness?.id, projects, canFinancials, yearStart]);

  const fmtMoney = (n: number | null) =>
    n == null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: baseCurrency, maximumFractionDigits: 0 }).format(n);

  function buildExportConfig(key: ReportKey): ExportConfig {
    const meta = META[key];
    return {
      title: meta.title,
      subtitle: undefined,
      dateRange: `YTD ${format(new Date(), "yyyy")}`,
      columns: [],
      rows: [],
      currency: baseCurrency,
      // Server-build hints picked up by ReportPreviewDialog
      ...({
        reportType: meta.reportType,
        dateFrom: yearStart.slice(0, 10),
        dateTo: todayIso,
        organizationId: currentOrg?.id,
        businessId: currentBusiness?.id,
        filters: {},
      } as unknown as Partial<ExportConfig>),
    };
  }

  const visibleReports = (Object.keys(META) as ReportKey[]).filter(
    (k) => !META[k].financeOnly || canFinancials,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Project Reports</h1>
        <p className="text-muted-foreground">Preview, download and print project reports — same engine as Finance.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Revenue YTD</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {!canFinancials
              ? <div className="text-xs text-muted-foreground flex items-center gap-1"><Lock className="h-3 w-3" /> Permission required</div>
              : revenueYtd === null ? <Skeleton className="h-7 w-28" /> : <div className="text-2xl font-bold">{fmtMoney(revenueYtd)}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Cost YTD</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {!canFinancials
              ? <div className="text-xs text-muted-foreground flex items-center gap-1"><Lock className="h-3 w-3" /> Permission required</div>
              : costYtd === null ? <Skeleton className="h-7 w-28" /> : <div className="text-2xl font-bold">{fmtMoney(costYtd)}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Hours YTD</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {hoursYtd === null ? <Skeleton className="h-7 w-28" /> : <div className="text-2xl font-bold">{hoursYtd.toFixed(1)}</div>}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {visibleReports.map((k) => {
          const meta = META[k];
          const Icon = meta.icon;
          return (
            <Card key={k}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Icon className="h-4 w-4" /> {meta.title}
                </CardTitle>
                <CardDescription>{meta.desc}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" size="sm" onClick={() => setOpenKey(k)}>
                  <Eye className="h-4 w-4 mr-2" /> Preview &amp; download
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {openKey && (
        <ReportPreviewDialog
          open={!!openKey}
          onOpenChange={(o) => { if (!o) setOpenKey(null); }}
          getExportConfig={() => buildExportConfig(openKey)}
        />
      )}
    </div>
  );
}
