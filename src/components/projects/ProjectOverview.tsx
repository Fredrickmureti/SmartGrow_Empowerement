/**
 * ProjectOverview — workspace landing tab.
 *
 * Every number is a real query against the analytic ledger / project tables.
 * No mocked KPIs; if data is missing the strip degrades to "—".
 */
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { format, isPast, isWithinInterval, addDays } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useProjectFinancials } from "@/hooks/projects";
import type { Project, ProjectTask } from "@/hooks/projects";
import { Link, useNavigate } from "react-router-dom";
import { Calendar, ListTodo, Clock, AlertCircle, Milestone, TrendingUp, GitBranch } from "lucide-react";
import { ProjectBurndownSparkline } from "./ProjectBurndownSparkline";

interface Props {
  project: Project;
  tasks: ProjectTask[];
}

interface MilestoneRow {
  id: string;
  name: string;
  deadline: string | null;
  is_reached: boolean | null;
}

export function ProjectOverview({ project, tasks }: Props) {
  const { data: financials } = useProjectFinancials(project.id);
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);
  const navigate = useNavigate();
  const [source, setSource] = useState<{
    leadTitle?: string | null;
    soNumber?: string | null;
  }>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("project_milestones")
        .select("id, name, deadline, is_reached")
        .eq("project_id", project.id)
        .order("deadline", { ascending: true, nullsFirst: false });
      if (!cancelled) setMilestones((data ?? []) as MilestoneRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: { leadTitle?: string | null; soNumber?: string | null } = {};
      if (project.source_lead_id) {
        const { data } = await supabase
          .from("crm_leads")
          .select("name")
          .eq("id", project.source_lead_id)
          .maybeSingle();
        next.leadTitle = data?.name ?? "Lead";
      }
      if (project.source_sales_order_id) {
        const { data } = await supabase
          .from("sales_orders")
          .select("so_number")
          .eq("id", project.source_sales_order_id)
          .maybeSingle();
        next.soNumber = data?.so_number ?? "Sales order";
      }
      if (!cancelled) setSource(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [project.source_lead_id, project.source_sales_order_id]);

  const today = new Date();
  const rootTasks = tasks.filter((t) => !t.parent_task_id);
  const openTasks = rootTasks.filter((t) => !t.is_done);
  const overdueTasks = openTasks.filter(
    (t) => t.deadline && isPast(new Date(t.deadline))
  );
  const dueSoon = openTasks
    .filter(
      (t) =>
        t.deadline &&
        isWithinInterval(new Date(t.deadline), {
          start: today,
          end: addDays(today, 14),
        })
    )
    .sort(
      (a, b) =>
        new Date(a.deadline as string).getTime() -
        new Date(b.deadline as string).getTime()
    )
    .slice(0, 8);

  const completedMs = milestones.filter((m) => m.is_reached).length;
  const milestonePct = milestones.length
    ? Math.round((completedMs / milestones.length) * 100)
    : null;

  const margin = financials?.margin ?? 0;
  const marginPct = financials?.margin_pct ?? null;
  const currency = financials?.currency || project.currency || null;
  const fmt = (v: number) =>
    currency
      ? new Intl.NumberFormat(undefined, {
          style: "currency",
          currency,
          maximumFractionDigits: 2,
        }).format(v)
      : "—";

  const updateColour: Record<string, string> = {
    on_track: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
    at_risk: "bg-amber-500/10 text-amber-600 border-amber-500/20",
    off_track: "bg-rose-500/10 text-rose-600 border-rose-500/20",
    done: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  };

  return (
    <div className="space-y-6">
      {/* KPI strip — every cell traces to a real source row */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardContent className="p-4 space-y-1">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <ListTodo className="h-3.5 w-3.5" /> Open / Overdue
            </div>
            <div className="text-2xl font-semibold">
              {openTasks.length}
              <span className="text-base text-muted-foreground"> / </span>
              <span
                className={
                  overdueTasks.length
                    ? "text-rose-600"
                    : "text-muted-foreground"
                }
              >
                {overdueTasks.length}
              </span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 space-y-1">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Clock className="h-3.5 w-3.5" /> Hours logged / planned
            </div>
            <div className="text-2xl font-semibold">
              {(financials?.logged_hours ?? 0).toFixed(1)}
              <span className="text-base text-muted-foreground">
                {" / "}
                {(financials?.planned_hours ?? 0).toFixed(1)}h
              </span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 space-y-1">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Milestone className="h-3.5 w-3.5" /> Milestones
            </div>
            <div className="text-2xl font-semibold">
              {milestonePct === null ? "—" : `${milestonePct}%`}
              <span className="text-xs text-muted-foreground ml-1">
                ({completedMs}/{milestones.length})
              </span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 space-y-1">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <TrendingUp className="h-3.5 w-3.5" /> Margin
            </div>
            <div
              className={`text-2xl font-semibold ${
                margin < 0 ? "text-rose-600" : "text-emerald-600"
              }`}
            >
              {fmt(margin)}
              {marginPct !== null && (
                <span className="text-xs text-muted-foreground ml-1">
                  ({marginPct.toFixed(1)}%)
                </span>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 space-y-1">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <AlertCircle className="h-3.5 w-3.5" /> Latest update
            </div>
            {project.last_update_status ? (
              <Badge
                variant="outline"
                className={updateColour[project.last_update_status] || ""}
              >
                {project.last_update_status.replace("_", " ")}
              </Badge>
            ) : (
              <div className="text-sm text-muted-foreground">No updates</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Provenance — where this project came from */}
      {(project.source_lead_id || project.source_sales_order_id) && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <GitBranch className="h-4 w-4 text-muted-foreground" /> Originated from
            </div>
            <div className="flex flex-wrap gap-2">
              {project.source_lead_id && (
                <Badge
                  variant="outline"
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => navigate(`/crm?lead=${project.source_lead_id}`)}
                >
                  Lead: {source.leadTitle ?? "…"}
                </Badge>
              )}
              {project.source_sales_order_id && (
                <Badge
                  variant="outline"
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => navigate(`/sales-orders?edit=${project.source_sales_order_id}`)}
                >
                  Sales order: {source.soNumber ?? "…"}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}



      {/* Deadlines next 14 days */}
      <ProjectBurndownSparkline projectId={project.id} />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Deadlines · next 14 days</h3>
          </div>
          {dueSoon.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing due in the next two weeks.
            </p>
          ) : (
            <ul className="divide-y">
              {dueSoon.map((t) => (
                <li
                  key={t.id}
                  className="py-2 flex items-center justify-between text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.task_number}
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      isPast(new Date(t.deadline as string))
                        ? "bg-rose-500/10 text-rose-600 border-rose-500/20"
                        : ""
                    }
                  >
                    {format(new Date(t.deadline as string), "MMM d")}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Quick links */}
      <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
        <Link to={`/projects-app/${project.id}/tasks`} className="underline-offset-2 hover:underline">
          View all tasks
        </Link>
        <Link to={`/projects-app/${project.id}/milestones`} className="underline-offset-2 hover:underline">
          Milestones
        </Link>
        <Link to={`/projects-app/${project.id}/financials`} className="underline-offset-2 hover:underline">
          Financials
        </Link>
        <Link to={`/projects-app/${project.id}/sales`} className="underline-offset-2 hover:underline">
          Sales
        </Link>
        <Link to={`/projects-app/${project.id}/purchases`} className="underline-offset-2 hover:underline">
          Purchases
        </Link>
      </div>
    </div>
  );
}
