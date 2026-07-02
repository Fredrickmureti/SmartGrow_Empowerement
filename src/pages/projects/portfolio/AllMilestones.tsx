/**
 * AllMilestones — cross-project milestones with due-soon / overdue / billing status.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useProjects } from "@/hooks/projects";
import { format, differenceInCalendarDays } from "date-fns";
import { Milestone as MilestoneIcon } from "lucide-react";
import { RunProjectReportButton } from "@/components/projects/RunProjectReportButton";

interface Row {
  id: string;
  project_id: string;
  name: string;
  deadline: string | null;
  is_reached: boolean;
  reached_at: string | null;
  billing_amount: number | null;
}

export default function AllMilestones() {
  const { projects } = useProjects();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function run() {
      const ids = projects.map((p) => p.id);
      if (ids.length === 0) { setRows([]); setLoading(false); return; }
      setLoading(true);
      const { data } = await supabase
        .from("project_milestones")
        .select("id, project_id, name, deadline, is_reached, reached_at, billing_amount")
        .in("project_id", ids)
        .order("deadline", { ascending: true, nullsFirst: false });
      if (alive) { setRows((data ?? []) as Row[]); setLoading(false); }
    }
    void run();
    return () => { alive = false; };
  }, [projects]);

  const projMap = new Map(projects.map((p) => [p.id, p] as const));

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Milestones</h1>
          <p className="text-muted-foreground text-sm">Cross-project milestone tracking and billing eligibility.</p>
        </div>
        <RunProjectReportButton reportType="project_status" title="Milestones" label="Print" />
      </div>
      <Card>
        <CardContent className="p-0">
          {loading ? <Skeleton className="h-40 w-full" /> : rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No milestones yet.</p>
          ) : (
            <div className="divide-y">
              {rows.map((m) => {
                const proj = projMap.get(m.project_id);
                const days = m.deadline ? differenceInCalendarDays(new Date(m.deadline), new Date()) : null;
                return (
                  <Link key={m.id} to={`/projects-app/${m.project_id}/milestones`} className="flex items-center justify-between gap-3 p-3 hover:bg-muted">
                    <div className="flex items-center gap-3 min-w-0">
                      <MilestoneIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{m.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{proj?.name ?? "—"} {m.deadline ? `· due ${format(new Date(m.deadline), "MMM d, yyyy")}` : ""}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {m.billing_amount && Number(m.billing_amount) > 0 && <Badge variant="outline">{Number(m.billing_amount).toFixed(2)}</Badge>}
                      {m.is_reached ? <Badge variant="secondary">Reached</Badge>
                        : days === null ? <Badge variant="outline">No date</Badge>
                        : days < 0 ? <Badge variant="destructive">{Math.abs(days)}d overdue</Badge>
                        : days <= 7 ? <Badge>Due in {days}d</Badge>
                        : <Badge variant="outline">{days}d</Badge>}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
