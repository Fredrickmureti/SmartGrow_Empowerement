/**
 * AllTasks — global task list across all projects in scope.
 * Filters: project, status (open/done), priority, assignee.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useProjects } from "@/hooks/projects";
import { format } from "date-fns";
import { RunProjectReportButton } from "@/components/projects/RunProjectReportButton";

interface Row {
  id: string;
  name: string;
  deadline: string | null;
  priority: number;
  is_done: boolean;
  project_id: string;
  assigned_to: string | null;
  project: { id: string; name: string; project_number: string } | null;
  stage: { id: string; name: string; color: string | null } | null;
}

export default function AllTasks() {
  const { currentOrg } = useOrganization();
  const { projects } = useProjects();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState<string>("all");
  const [status, setStatus] = useState<"open" | "done" | "all">("open");

  useEffect(() => {
    let alive = true;
    async function run() {
      if (!currentOrg) return;
      setLoading(true);
      let q = supabase
        .from("project_tasks")
        .select("id, name, deadline, priority, is_done, project_id, assigned_to, project:projects(id, name, project_number), stage:project_stages(id, name, color)")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true)
        .order("deadline", { ascending: true, nullsFirst: false })
        .limit(500);
      if (projectId !== "all") q = q.eq("project_id", projectId);
      if (status === "open") q = q.eq("is_done", false);
      if (status === "done") q = q.eq("is_done", true);
      const { data } = await q;
      if (alive) {
        setRows((data ?? []) as unknown as Row[]);
        setLoading(false);
      }
    }
    void run();
    return () => { alive = false; };
  }, [currentOrg?.id, projectId, status]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(s) || r.project?.name?.toLowerCase().includes(s));
  }, [rows, search]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">All Tasks</h1>
          <p className="text-muted-foreground text-sm">Cross-project task list with filters.</p>
        </div>
        <RunProjectReportButton
          projectId={projectId !== "all" ? projectId : undefined}
          reportType="project_status"
          title="Tasks report"
          label="Print"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Input placeholder="Search tasks..." value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as "open" | "done" | "all")}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="done">Done</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Card>
        <CardContent className="p-0">
          {loading ? <Skeleton className="h-40 w-full" /> : filtered.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No tasks match.</p>
          ) : (
            <div className="divide-y">
              {filtered.map((r) => (
                <Link key={r.id} to={`/projects-app/${r.project_id}/tasks`} className="flex items-center justify-between gap-3 p-3 hover:bg-muted">
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium truncate ${r.is_done ? "line-through text-muted-foreground" : ""}`}>{r.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{r.project?.name ?? "—"} {r.deadline ? `· ${format(new Date(r.deadline), "MMM d, yyyy")}` : ""}</p>
                  </div>
                  {r.stage && <Badge variant="outline" style={r.stage.color ? { borderColor: r.stage.color } : undefined}>{r.stage.name}</Badge>}
                  {r.priority > 0 && <Badge variant="secondary">P{r.priority}</Badge>}
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
