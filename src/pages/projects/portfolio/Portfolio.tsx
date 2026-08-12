/**
 * ProjectsPortfolio — top-level dashboard across all projects in scope.
 *
 * Data is real: counts come from useProjects (org+business scoped), hours
 * from `timesheets`, overdue from `project_tasks`, margin YTD from
 * `project_revenue_entries` minus `project_cost_entries`. Recent updates
 * from `project_updates`. Deadline radar from `projects.end_date` +
 * `project_milestones.deadline`.
 */
import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useProjects } from "@/hooks/projects";
import { format, startOfWeek, startOfYear, formatDistanceToNow, differenceInCalendarDays } from "date-fns";
import { FolderKanban, Clock, AlertTriangle, TrendingUp, MessageSquare, CalendarClock, Wallet, Flag } from "lucide-react";
import { RunProjectReportButton } from "@/components/projects/RunProjectReportButton";

interface Kpis {
  activeProjects: number;
  hoursWeek: number;
  overdueTasks: number;
  marginYtd: number;
  revenueYtd: number;
  costYtd: number;
  atRiskCount: number;
  overBudgetCount: number;
  overdueMilestonesWeek: number;
  unbilledHours: number;
}

export default function ProjectsPortfolio() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { projects, isLoading: loadingProjects } = useProjects();
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [updates, setUpdates] = useState<Array<{ id: string; project_id: string; status: string; summary: string; created_at: string; project_name?: string }>>([]);
  const [deadlines, setDeadlines] = useState<Array<{ id: string; kind: "project" | "milestone"; name: string; due: string; project_id: string; project_name?: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!currentOrg) return;
      setIsLoading(true);
      try {
        const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 }).toISOString();
        const yearStart = startOfYear(new Date()).toISOString();

        const projectIds = projects.map((p) => p.id);
        const safeIn = projectIds.length > 0 ? projectIds : ["00000000-0000-0000-0000-000000000000"];
        const bizId = currentBusiness?.id ?? null;

        let tsQ = supabase.from("timesheets").select("hours").eq("organization_id", currentOrg.id).gte("date", weekStart.slice(0, 10));
        if (bizId) tsQ = tsQ.eq("business_id", bizId);
        let overdueQ = supabase.from("project_tasks").select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id).eq("is_done", false).eq("is_active", true).lt("deadline", new Date().toISOString().slice(0, 10));
        if (bizId) overdueQ = overdueQ.eq("business_id", bizId);
        let revQ = supabase.from("project_revenue_entries").select("amount").in("project_id", safeIn).gte("posted_at", yearStart);
        if (bizId) revQ = revQ.eq("business_id", bizId);
        let costQ = supabase.from("project_cost_entries").select("amount").in("project_id", safeIn).gte("posted_at", yearStart);
        if (bizId) costQ = costQ.eq("business_id", bizId);

        const [tsRes, overdueRes, revRes, costRes, updRes, msRes, kpiRes] = await Promise.all([
          tsQ,
          overdueQ,
          revQ,
          costQ,
          supabase.from("project_updates").select("id, project_id, status, summary, created_at").in("project_id", safeIn).order("created_at", { ascending: false }).limit(8),
          supabase.from("project_milestones").select("id, project_id, name, deadline").in("project_id", safeIn).eq("is_reached", false).not("deadline", "is", null).order("deadline", { ascending: true }).limit(20),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase.from as any)("project_portfolio_kpis")
            .select("at_risk_count, over_budget_count, overdue_milestones_week, unbilled_timesheet_hours")
            .eq("organization_id", currentOrg.id)
            .maybeSingle(),
        ]);

        if (cancelled) return;

        const hoursWeek = (tsRes.data ?? []).reduce((s, r: { hours: number | null }) => s + Number(r.hours ?? 0), 0);
        const revenueYtd = (revRes.data ?? []).reduce((s, r: { amount: number | null }) => s + Number(r.amount ?? 0), 0);
        const costYtd = (costRes.data ?? []).reduce((s, r: { amount: number | null }) => s + Number(r.amount ?? 0), 0);
        const k = (kpiRes?.data ?? {}) as { at_risk_count?: number; over_budget_count?: number; overdue_milestones_week?: number; unbilled_timesheet_hours?: number };

        setKpis({
          activeProjects: projects.filter((p) => p.status === "active").length,
          hoursWeek,
          overdueTasks: overdueRes.count ?? 0,
          marginYtd: revenueYtd - costYtd,
          revenueYtd,
          costYtd,
          atRiskCount: Number(k.at_risk_count ?? 0),
          overBudgetCount: Number(k.over_budget_count ?? 0),
          overdueMilestonesWeek: Number(k.overdue_milestones_week ?? 0),
          unbilledHours: Number(k.unbilled_timesheet_hours ?? 0),
        });

        const projMap = new Map(projects.map((p) => [p.id, p.name] as const));
        setUpdates((updRes.data ?? []).map((u: { id: string; project_id: string; status: string; summary: string; created_at: string }) => ({ ...u, project_name: projMap.get(u.project_id) })));

        const projDeadlines = projects
          .filter((p) => p.end_date && p.status !== "completed" && p.status !== "cancelled")
          .map((p) => ({ id: p.id, kind: "project" as const, name: p.name, due: p.end_date as string, project_id: p.id, project_name: p.name }));
        const msDeadlines = (msRes.data ?? []).map((m: { id: string; project_id: string; name: string; deadline: string }) => ({
          id: m.id, kind: "milestone" as const, name: m.name, due: m.deadline, project_id: m.project_id, project_name: projMap.get(m.project_id),
        }));
        const merged = [...projDeadlines, ...msDeadlines]
          .filter((d) => differenceInCalendarDays(new Date(d.due), new Date()) <= 30)
          .sort((a, b) => a.due.localeCompare(b.due))
          .slice(0, 12);
        setDeadlines(merged);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [currentOrg, currentBusiness, projects]);

  const baseCurrency = currentBusiness?.base_currency ?? "";
  const cards = useMemo(() => ([
    { label: "Active projects", value: kpis?.activeProjects ?? 0, icon: FolderKanban },
    { label: "Hours this week", value: (kpis?.hoursWeek ?? 0).toFixed(1), icon: Clock },
    { label: "Overdue tasks", value: kpis?.overdueTasks ?? 0, icon: AlertTriangle },
    { label: `Margin YTD (${baseCurrency})`, value: new Intl.NumberFormat(undefined, { style: "currency", currency: baseCurrency, maximumFractionDigits: 0 }).format(kpis?.marginYtd ?? 0), icon: TrendingUp },
  ]), [kpis, baseCurrency]);

  const showSkeleton = loadingProjects || isLoading;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects Overview</h1>
          <p className="text-muted-foreground text-sm">Portfolio health, deadlines and recent updates.</p>
        </div>
        <RunProjectReportButton
          reportType="project_portfolio"
          title="Projects Portfolio"
          label="Portfolio report"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{c.label}</p>
                  <p className="text-2xl font-bold mt-1">{showSkeleton ? <Skeleton className="h-7 w-20" /> : c.value}</p>
                </div>
                <c.icon className="h-5 w-5 text-muted-foreground" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "At-risk projects", value: kpis?.atRiskCount ?? 0, icon: AlertTriangle, to: "/projects-app/list?status=at_risk", tone: (kpis?.atRiskCount ?? 0) > 0 ? "destructive" : "default" },
          { label: "Over budget", value: kpis?.overBudgetCount ?? 0, icon: Wallet, to: "/projects-app/list?filter=over_budget", tone: (kpis?.overBudgetCount ?? 0) > 0 ? "destructive" : "default" },
          { label: "Milestones due ≤7d", value: kpis?.overdueMilestonesWeek ?? 0, icon: Flag, to: "/projects-app/milestones?window=week", tone: (kpis?.overdueMilestonesWeek ?? 0) > 0 ? "default" : "default" },
          { label: "Unbilled hours", value: (kpis?.unbilledHours ?? 0).toFixed(1), icon: Clock, to: "/timesheets?billable=true&invoiced=false&status=approved", tone: "default" },
        ].map((c) => (
          <Link key={c.label} to={c.to}>
            <Card className="hover:bg-muted/40 transition-colors cursor-pointer">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">{c.label}</p>
                    <p className="text-2xl font-bold mt-1">{showSkeleton ? <Skeleton className="h-7 w-20" /> : c.value}</p>
                  </div>
                  <c.icon className={`h-5 w-5 ${c.tone === "destructive" ? "text-destructive" : "text-muted-foreground"}`} />
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><CalendarClock className="h-4 w-4" />Deadline radar (next 30 days)</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {showSkeleton ? <Skeleton className="h-24 w-full" /> : deadlines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No upcoming deadlines.</p>
            ) : deadlines.map((d) => {
              const daysLeft = differenceInCalendarDays(new Date(d.due), new Date());
              return (
                <Link key={`${d.kind}-${d.id}`} to={`/projects-app/${d.project_id}/${d.kind === "milestone" ? "milestones" : "overview"}`}
                  className="flex items-center justify-between rounded-md p-2 hover:bg-muted">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{d.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{d.kind === "milestone" ? `Milestone · ${d.project_name}` : "Project end date"}</p>
                  </div>
                  <Badge variant={daysLeft < 0 ? "destructive" : daysLeft <= 7 ? "default" : "secondary"}>
                    {daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : daysLeft === 0 ? "Today" : `${daysLeft}d`}
                  </Badge>
                </Link>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><MessageSquare className="h-4 w-4" />Recent project updates</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {showSkeleton ? <Skeleton className="h-24 w-full" /> : updates.length === 0 ? (
              <p className="text-sm text-muted-foreground">No updates yet.</p>
            ) : updates.map((u) => (
              <Link key={u.id} to={`/projects-app/${u.project_id}/updates`} className="block rounded-md p-2 hover:bg-muted">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium truncate">{u.project_name ?? "Project"}</p>
                  <Badge variant={u.status === "on_track" ? "default" : u.status === "at_risk" ? "secondary" : "destructive"}>{u.status.replace("_", " ")}</Badge>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{u.summary}</p>
                <p className="text-xs text-muted-foreground mt-1">{formatDistanceToNow(new Date(u.created_at), { addSuffix: true })}</p>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Active projects</CardTitle></CardHeader>
        <CardContent>
          {showSkeleton ? <Skeleton className="h-32 w-full" /> : (
            <div className="grid gap-3">
              {projects.filter((p) => p.status === "active").slice(0, 8).map((p) => (
                <Link key={p.id} to={`/projects-app/${p.id}/overview`} className="flex items-center justify-between rounded-md p-3 border hover:bg-muted">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{p.name}</p>
                    <p className="text-xs text-muted-foreground">{p.project_number} {p.end_date ? `· due ${format(new Date(p.end_date), "MMM d, yyyy")}` : ""}</p>
                  </div>
                  <div className="w-32"><Progress value={p.progress ?? 0} /></div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
