/**
 * MyTasks — cross-project tasks for the current user.
 *
 * Includes tasks where assigned_to = auth.uid() OR the user is in the
 * `assignees` array. Grouped Today / This Week / Overdue / Later.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/hooks/useOrganization";
import { format, isToday, isPast, differenceInCalendarDays } from "date-fns";
import { toast } from "sonner";
import { RunProjectReportButton } from "@/components/projects/RunProjectReportButton";

interface Row {
  id: string;
  name: string;
  deadline: string | null;
  priority: number;
  is_done: boolean;
  project_id: string;
  project: { id: string; name: string; project_number: string } | null;
}

export default function MyTasks() {
  const { user } = useAuth();
  const { currentOrg } = useOrganization();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!user || !currentOrg) return;
    setLoading(true);
    // assigned_to OR assignees contains user
    const { data, error } = await supabase
      .from("project_tasks")
      .select("id, name, deadline, priority, is_done, project_id, project:projects(id, name, project_number)")
      .eq("organization_id", currentOrg.id)
      .eq("is_active", true)
      .or(`assigned_to.eq.${user.id},assignees.cs.{${user.id}}`)
      .order("deadline", { ascending: true, nullsFirst: false });
    if (error) { toast.error("Failed to load tasks"); setLoading(false); return; }
    setRows((data ?? []) as unknown as Row[]);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user?.id, currentOrg?.id]);

  const groups = useMemo(() => {
    const today: Row[] = [], week: Row[] = [], overdue: Row[] = [], later: Row[] = [], done: Row[] = [];
    for (const r of rows) {
      if (r.is_done) { done.push(r); continue; }
      if (!r.deadline) { later.push(r); continue; }
      const d = new Date(r.deadline);
      if (isPast(d) && !isToday(d)) overdue.push(r);
      else if (isToday(d)) today.push(r);
      else if (differenceInCalendarDays(d, new Date()) <= 7) week.push(r);
      else later.push(r);
    }
    return { overdue, today, week, later, done };
  }, [rows]);

  const toggleDone = async (r: Row) => {
    // Wave 2: task completion is server-governed (dependency + closed-project
    // guards, non-forgeable activity log). Never flip `is_done` from here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.rpc as any)(
      r.is_done ? "project_task_reopen" : "project_task_complete",
      { _task_id: r.id },
    );
    if (error) { toast.error(error.message ?? "Failed to update"); return; }
    void load();
  };


  const Section = ({ title, items, tone }: { title: string; items: Row[]; tone?: "destructive" | "default" }) => (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base">{title}<Badge variant={tone ?? "secondary"}>{items.length}</Badge></CardTitle></CardHeader>
      <CardContent className="space-y-1">
        {items.length === 0 ? <p className="text-sm text-muted-foreground">Nothing here.</p> : items.map((r) => (
          <div key={r.id} className="flex items-center gap-3 rounded-md p-2 hover:bg-muted">
            <Checkbox checked={r.is_done} onCheckedChange={() => toggleDone(r)} />
            <Link to={`/projects-app/${r.project_id}/tasks`} className="flex-1 min-w-0">
              <p className={`text-sm font-medium truncate ${r.is_done ? "line-through text-muted-foreground" : ""}`}>{r.name}</p>
              <p className="text-xs text-muted-foreground truncate">{r.project?.name ?? "—"} {r.deadline ? `· ${format(new Date(r.deadline), "MMM d")}` : ""}</p>
            </Link>
            {r.priority > 0 && <Badge variant="outline">P{r.priority}</Badge>}
          </div>
        ))}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Tasks</h1>
          <p className="text-muted-foreground text-sm">Tasks assigned to you across all projects.</p>
        </div>
        <RunProjectReportButton reportType="project_status" title="My tasks" label="Print" />
      </div>
      {loading ? <Skeleton className="h-40 w-full" /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Overdue" items={groups.overdue} tone="destructive" />
          <Section title="Today" items={groups.today} />
          <Section title="This week" items={groups.week} />
          <Section title="Later" items={groups.later} />
          {groups.done.length > 0 && <Section title="Recently done" items={groups.done.slice(0, 10)} />}
        </div>
      )}
    </div>
  );
}
