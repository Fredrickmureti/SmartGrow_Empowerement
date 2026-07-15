/**
 * MyTeamTalent — Phase D manager analytics page (mounted at `/me/team/talent`).
 *
 * One screen surfacing the things a people-manager needs to action this week:
 *  - team-wide goal health & overdue check-ins
 *  - review-cycle completion for the team
 *  - dev-plan coverage
 *  - kudos momentum
 *  - quick links into 1:1s, feedback, goals, reviews
 *
 * Data comes from `v_manager_team_rollup` (RLS-scoped) plus light enrichment
 * to list direct reports with their per-person state.
 */
import { Link } from "react-router-dom";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useManagerTeamRollup } from "@/hooks/useTalentAnalytics";
import { useOrganization } from "@/hooks/useOrganization";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Users, Target, AlertTriangle, ClipboardCheck, BookOpen, Heart,
  MessageSquare, CalendarClock, ArrowRight
} from "lucide-react";
import { PageHeader, PageBody } from "@/design-system";
import { KpiStrip } from "@/components/hr/KpiStrip";

interface ReportRow {
  id: string;
  first_name: string;
  last_name: string;
  active_goals: number;
  at_risk_goals: number;
  overdue: number;
  has_devplan: boolean;
  review_done: boolean;
}

export default function MyTeamTalent() {
  const { rollup, isLoading, meEmployeeId } = useManagerTeamRollup();
  const { currentOrg } = useOrganization();

  const { data: reports = [] } = useQuery({
    queryKey: ["team-talent-reports", currentOrg?.id, meEmployeeId],
    enabled: !!currentOrg?.id && !!meEmployeeId,
    queryFn: async (): Promise<ReportRow[]> => {
      const { data: emps } = await supabase
        .from("v_employees_canonical")
        .select("id, first_name, last_name")
        .eq("organization_id", currentOrg!.id)
        .eq("manager_id", meEmployeeId!)
        .eq("is_operationally_active", true);
      const list = (emps as { id: string; first_name: string; last_name: string }[] | null) ?? [];
      if (list.length === 0) return [];
      const ids = list.map((e) => e.id);

      const [{ data: goals }, { data: plans }, { data: cycles }] = await Promise.all([
        supabase.from("performance_goals").select("employee_id,status,next_check_in_due_at").in("employee_id", ids),
        supabase.from("development_plans").select("employee_id,status").in("employee_id", ids),
        supabase.from("performance_cycles").select("id,phase").neq("phase", "closed").limit(1),
      ]);

      const activeCycleId = (cycles as { id: string }[] | null)?.[0]?.id;
      let reviewMap = new Map<string, boolean>();
      if (activeCycleId) {
        const { data: reviews } = await supabase
          .from("performance_reviews")
          .select("employee_id, status, signed_off_at")
          .eq("cycle_id", activeCycleId)
          .in("employee_id", ids);
        reviewMap = new Map(
          ((reviews as any[]) ?? []).map((r) => [
            r.employee_id,
            !!r.signed_off_at || r.status === "acknowledged",
          ]),
        );
      }

      const planSet = new Set(((plans as any[]) ?? []).filter((p) => ["draft","active","approved","in_progress"].includes(p.status)).map((p) => p.employee_id));
      const now = Date.now();

      return list.map((e) => {
        const gs = ((goals as any[]) ?? []).filter((g) => g.employee_id === e.id);
        return {
          id: e.id,
          first_name: e.first_name,
          last_name: e.last_name,
          active_goals: gs.filter((g) => ["not_started","in_progress","at_risk"].includes(g.status)).length,
          at_risk_goals: gs.filter((g) => g.status === "at_risk").length,
          overdue: gs.filter((g) => g.next_check_in_due_at && new Date(g.next_check_in_due_at).getTime() < now && ["not_started","in_progress","at_risk"].includes(g.status)).length,
          has_devplan: planSet.has(e.id),
          review_done: reviewMap.get(e.id) ?? false,
        };
      });
    },
  });

  const empty = !isLoading && !rollup;

  return (
    <>
      <PageHeader
        title="Team talent"
        description="Goal health, reviews, and development across your direct reports."
        actions={
          <>
            <Button asChild variant="outline" size="sm"><Link to="/me/one-on-ones"><CalendarClock className="h-4 w-4 mr-1" />1:1s</Link></Button>
            <Button asChild variant="outline" size="sm"><Link to="/me/talent/feedback"><MessageSquare className="h-4 w-4 mr-1" />Feedback</Link></Button>
          </>
        }
      />
      <PageBody>
      <KpiStrip
        tiles={[
          { key: "team", label: "Team size", value: rollup?.team_size ?? 0, icon: Users, tone: "neutral" },
          {
            key: "goals",
            label: "Active goals",
            value: rollup?.active_goals ?? 0,
            icon: Target,
            tone: rollup?.at_risk_goals ? "amber" : "neutral",
            hint: rollup?.at_risk_goals ? `${rollup.at_risk_goals} at risk` : undefined,
          },
          {
            key: "overdue",
            label: "Overdue check-ins",
            value: rollup?.overdue_check_ins ?? 0,
            icon: AlertTriangle,
            tone: rollup?.overdue_check_ins ? "rose" : "neutral",
          },
          { key: "kudos", label: "Kudos (30d)", value: rollup?.kudos_last_30d ?? 0, icon: Heart, tone: "sky" },
        ]}
      />


      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ClipboardCheck className="h-4 w-4" />Review completion</CardTitle>
            <CardDescription>Active cycle</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>{rollup?.reviews_done ?? 0} of {rollup?.reviews_total ?? 0} signed off</span>
              <span className="font-medium">{rollup?.review_completion_pct ?? 0}%</span>
            </div>
            <Progress value={rollup?.review_completion_pct ?? 0} />
            <Button asChild variant="ghost" size="sm" className="px-0"><Link to="/hr/talent/reviews">Open reviews <ArrowRight className="h-3 w-3 ml-1" /></Link></Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><BookOpen className="h-4 w-4" />Development plan coverage</CardTitle>
            <CardDescription>Active dev-plan per direct report</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>{rollup?.employees_with_devplan ?? 0} of {rollup?.team_size ?? 0}</span>
              <span className="font-medium">{rollup?.devplan_coverage_pct ?? 0}%</span>
            </div>
            <Progress value={rollup?.devplan_coverage_pct ?? 0} />
            <Button asChild variant="ghost" size="sm" className="px-0"><Link to="/hr/talent/development">Open development plans <ArrowRight className="h-3 w-3 ml-1" /></Link></Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Direct reports</CardTitle>
          <CardDescription>Tap a row to drill into goals and reviews.</CardDescription>
        </CardHeader>
        <CardContent>
          {empty || reports.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No direct reports linked to your employee record.</p>
          ) : (
            <div className="divide-y">
              {reports.map((r) => (
                <div key={r.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.first_name} {r.last_name}</div>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      <Badge variant="outline">{r.active_goals} goals</Badge>
                      {r.at_risk_goals > 0 && <Badge variant="destructive">{r.at_risk_goals} at risk</Badge>}
                      {r.overdue > 0 && <Badge variant="secondary">{r.overdue} overdue</Badge>}
                      {!r.has_devplan && <Badge variant="outline" className="text-amber-600 border-amber-300">No dev plan</Badge>}
                      <Badge variant={r.review_done ? "default" : "outline"}>{r.review_done ? "Review ✓" : "Review pending"}</Badge>
                    </div>
                  </div>
                  <Button asChild variant="ghost" size="sm"><Link to={`/hr/employees/${r.id}`}>Open <ArrowRight className="h-3 w-3 ml-1" /></Link></Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      </PageBody>
    </>
  );
}



