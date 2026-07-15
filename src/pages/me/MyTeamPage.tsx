/**
 * Manager's Team view — one screen showing every direct report with their
 * current cycle status, goal health (count, avg progress, at-risk), and
 * development-plan progress. Designed to be the manager's daily landing
 * for talent management.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/hooks/useOrganization";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Users, Target, ClipboardList, BookOpen, AlertTriangle } from "lucide-react";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";

interface Report {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  user_id: string | null;
  position: string | null;
  department_name: string | null;
}

export default function MyTeamPage() {
  const { user } = useAuth();
  const { currentOrg } = useOrganization();

  // Find the manager's employee row, then their direct reports.
  const { data: reports = [], isLoading } = useQuery({
    queryKey: ["my-team-reports", currentOrg?.id, user?.id],
    queryFn: async () => {
      if (!user?.id || !currentOrg?.id) return [];
      const { data: me } = await supabase
        .from("v_employees_canonical")
        .select("id")
        .eq("user_id", user.id)
        .eq("organization_id", currentOrg.id)
        .maybeSingle();
      if (!me?.id) return [];
      const { data, error } = await supabase
        .from("v_employees_canonical")
        .select("id, first_name, last_name, email, user_id, position, department")
        .eq("manager_id", me.id)
        .eq("is_operationally_active", true);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        ...r,
        department_name: r.department ?? null,
      })) as Report[];
    },
    enabled: !!user?.id && !!currentOrg?.id,
  });

  const reportIds = reports.map((r) => r.id);

  // Pull goals + reviews + plans for all reports in one go.
  const { data: goals = [] } = useQuery({
    queryKey: ["my-team-goals", reportIds.join(",")],
    queryFn: async () => {
      if (reportIds.length === 0) return [];
      const { data } = await (supabase.from("performance_goals") as any)
        .select("id, employee_id, status, progress_pct, title")
        .in("employee_id", reportIds);
      return data ?? [];
    },
    enabled: reportIds.length > 0,
  });

  const { data: reviews = [] } = useQuery({
    queryKey: ["my-team-reviews", reportIds.join(",")],
    queryFn: async () => {
      if (reportIds.length === 0) return [];
      const { data } = await (supabase.from("performance_reviews") as any)
        .select("id, employee_id, status, review_type, due_at")
        .in("employee_id", reportIds);
      return data ?? [];
    },
    enabled: reportIds.length > 0,
  });

  const { data: plans = [] } = useQuery({
    queryKey: ["my-team-plans", reportIds.join(",")],
    queryFn: async () => {
      if (reportIds.length === 0) return [];
      const { data: pl } = await (supabase.from("development_plans") as any)
        .select("id, employee_id, status")
        .in("employee_id", reportIds);
      const planIds = (pl ?? []).map((p: any) => p.id);
      if (planIds.length === 0) return [];
      const { data: items } = await (supabase.from("development_plan_items") as any)
        .select("plan_id, status, progress_pct")
        .in("plan_id", planIds);
      return (pl ?? []).map((p: any) => ({
        ...p,
        items: (items ?? []).filter((i: any) => i.plan_id === p.id),
      }));
    },
    enabled: reportIds.length > 0,
  });

  const rows = useMemo(() => {
    return reports.map((r) => {
      const empGoals = goals.filter((g: any) => g.employee_id === r.id);
      const avgProgress = empGoals.length
        ? empGoals.reduce((s: number, g: any) => s + (g.progress_pct ?? 0), 0) / empGoals.length
        : 0;
      const atRisk = empGoals.filter((g: any) => g.status === "at_risk").length;
      const empReviews = reviews.filter((rv: any) => rv.employee_id === r.id);
      const reviewOverdue = empReviews.filter((rv: any) =>
        rv.due_at && new Date(rv.due_at).getTime() < Date.now() &&
        !["submitted", "calibrated", "signed_off", "acknowledged"].includes(rv.status),
      ).length;
      const empPlans = plans.filter((p: any) => p.employee_id === r.id);
      const planItems = empPlans.flatMap((p: any) => p.items as any[]);
      const planProgress = planItems.length
        ? planItems.reduce((s: number, i: any) => s + (i.progress_pct ?? 0), 0) / planItems.length
        : 0;
      return { report: r, empGoals, avgProgress, atRisk, empReviews, reviewOverdue, planItems, planProgress };
    });
  }, [reports, goals, reviews, plans]);

  return (
    <>
      <PageHeader title="My team" description="Talent management snapshot for each of your direct reports." />
      <PageBody>
      {isLoading ? <LoadingState /> :
        rows.length === 0 ? (
          <EmptyState icon={Users} title="No direct reports assigned yet" />
        ) : (
          <div className="grid gap-3">
            {rows.map(({ report, empGoals, avgProgress, atRisk, empReviews, reviewOverdue, planItems, planProgress }) => (
              <Card key={report.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">{report.first_name} {report.last_name}</CardTitle>
                      <CardDescription>
                        {report.position ?? "—"}{report.department_name ? ` · ${report.department_name}` : ""}
                      </CardDescription>
                    </div>
                    {reviewOverdue > 0 ? (
                      <Badge variant="destructive" className="flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" /> {reviewOverdue} overdue
                      </Badge>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid md:grid-cols-3 gap-4">
                    <Tile
                      icon={<Target className="h-4 w-4" />}
                      title="Goals"
                      to={`/hr/talent/goals?employeeId=${report.id}`}
                      primary={`${empGoals.length} active`}
                      secondary={atRisk > 0 ? `${atRisk} at risk` : "On track"}
                      tone={atRisk > 0 ? "warn" : "ok"}
                      progress={avgProgress}
                    />
                    <Tile
                      icon={<ClipboardList className="h-4 w-4" />}
                      title="Reviews"
                      to={`/hr/talent/reviews`}
                      primary={`${empReviews.length} this cycle`}
                      secondary={
                        reviewOverdue > 0 ? `${reviewOverdue} overdue` :
                        empReviews.filter((r: any) => r.status === "submitted").length + " submitted"
                      }
                      tone={reviewOverdue > 0 ? "warn" : "default"}
                    />
                    <Tile
                      icon={<BookOpen className="h-4 w-4" />}
                      title="Development plan"
                      to={`/hr/talent/development?employeeId=${report.id}`}
                      primary={`${planItems.length} actions`}
                      secondary={planItems.length ? `${planItems.filter((i: any) => i.status === "completed").length} done` : "No plan"}
                      tone="default"
                      progress={planItems.length ? planProgress : undefined}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}

function Tile({ icon, title, primary, secondary, to, tone, progress }: {
  icon: React.ReactNode; title: string; primary: string; secondary: string;
  to: string; tone: "ok" | "warn" | "default"; progress?: number;
}) {
  const toneCls =
    tone === "warn" ? "border-amber-500/40 bg-amber-500/5" :
    tone === "ok" ? "border-emerald-500/40" : "";
  return (
    <Link to={to} className={`block rounded-md border p-3 hover:bg-accent ${toneCls}`}>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        {icon} {title}
      </div>
      <p className="mt-1 text-lg font-semibold">{primary}</p>
      <p className="text-xs text-muted-foreground">{secondary}</p>
      {progress != null ? <Progress value={progress} className="mt-2 h-1.5" /> : null}
    </Link>
  );
}
