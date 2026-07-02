/**
 * Workload — Resource planning grid (Odoo Planning equivalent).
 *
 * Reads `project_member_workload_week` (security_invoker view) and renders a
 * member × week heatmap of planned vs logged hours against a 40h capacity.
 * No client-side aggregation of raw rows — the view does the math.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { format, startOfWeek } from "date-fns";
import { Users } from "lucide-react";
import { RunProjectReportButton } from "@/components/projects/RunProjectReportButton";

interface Row {
  week_start: string;
  user_id: string;
  business_id: string | null;
  planned_hours: number;
  logged_hours: number;
  capacity_hours: number;
  over_capacity: boolean;
}

export default function Workload() {
  const { currentBusiness } = useBusinesses();
  const [rows, setRows] = useState<Row[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Array<{ id: string; name: string; manager_id: string | null }>>([]);
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [managerFilter, setManagerFilter] = useState<string>("all");
  const [projectMembers, setProjectMembers] = useState<Set<string> | null>(null);
  const [managerMembers, setManagerMembers] = useState<Set<string> | null>(null);

  // Load project list for filter dropdown (also exposes manager assignments).
  useEffect(() => {
    let cancelled = false;
    async function loadProjects() {
      let q = supabase
        .from("projects")
        .select("id, name, manager_id")
        .order("name");
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      const { data } = await q;
      if (!cancelled) setProjects((data ?? []) as typeof projects);
    }
    void loadProjects();
    return () => { cancelled = true; };
  }, [currentBusiness?.id]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (supabase.from as any)("project_member_workload_week").select("*");
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      const { data } = await q;
      if (cancelled) return;
      const list = (data ?? []) as Row[];
      setRows(list);

      const userIds = Array.from(new Set(list.map((r) => r.user_id)));
      if (userIds.length) {
        const { data: pp } = await supabase
          .from("profiles")
          .select("id, full_name, email")
          .in("id", userIds);
        const map: Record<string, string> = {};
        (pp ?? []).forEach((p: { id: string; full_name: string | null; email: string | null }) => {
          map[p.id] = p.full_name ?? p.email ?? p.id.slice(0, 8);
        });
        setProfiles(map);
      }
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [currentBusiness?.id, projectFilter]);

  // Resolve member set when a project filter is active. The workload view
  // aggregates per user/week without a project column, so we narrow by the
  // project's member roster.
  useEffect(() => {
    let cancelled = false;
    async function loadMembers() {
      if (projectFilter === "all") { setProjectMembers(null); return; }
      const { data } = await supabase
        .from("project_members")
        .select("user_id")
        .eq("project_id", projectFilter);
      if (cancelled) return;
      setProjectMembers(new Set((data ?? []).map((r) => r.user_id)));
    }
    void loadMembers();
    return () => { cancelled = true; };
  }, [projectFilter]);

  // Resolve member set for the manager filter: union of members across every
  // project where manager_id = managerFilter. Real intersection — never a no-op.
  useEffect(() => {
    let cancelled = false;
    async function loadManagerMembers() {
      if (managerFilter === "all") { setManagerMembers(null); return; }
      const managedIds = projects
        .filter((p) => p.manager_id === managerFilter)
        .map((p) => p.id);
      if (managedIds.length === 0) { setManagerMembers(new Set()); return; }
      const { data } = await supabase
        .from("project_members")
        .select("user_id")
        .in("project_id", managedIds);
      if (cancelled) return;
      setManagerMembers(new Set((data ?? []).map((r) => r.user_id)));
    }
    void loadManagerMembers();
    return () => { cancelled = true; };
  }, [managerFilter, projects]);

  // Apply project + manager filters client-side.
  const filteredRows = useMemo(() => {
    let out = rows;
    if (projectMembers) out = out.filter((r) => projectMembers.has(r.user_id));
    if (managerMembers) out = out.filter((r) => managerMembers.has(r.user_id));
    return out;
  }, [rows, projectMembers, managerMembers]);

  const { weeks, members, byKey } = useMemo(() => {
    const wks = Array.from(new Set(filteredRows.map((r) => r.week_start))).sort();
    const mems = Array.from(new Set(filteredRows.map((r) => r.user_id)));
    const map = new Map<string, Row>();
    filteredRows.forEach((r) => map.set(`${r.user_id}|${r.week_start}`, r));
    return { weeks: wks, members: mems, byKey: map };
  }, [filteredRows]);

  function cellClass(r: Row | undefined) {
    if (!r) return "bg-muted/30";
    const ratio = r.capacity_hours ? r.logged_hours / r.capacity_hours : 0;
    if (ratio === 0) return "bg-muted/40";
    if (ratio < 0.5) return "bg-emerald-500/20";
    if (ratio < 0.85) return "bg-emerald-500/40";
    if (ratio <= 1) return "bg-amber-500/50";
    return "bg-destructive/60 text-destructive-foreground";
  }

  const currentWeek = startOfWeek(new Date(), { weekStartsOn: 1 }).toISOString().slice(0, 10);

  const managers = useMemo(() => {
    const ids = Array.from(
      new Set(projects.map((p) => p.manager_id).filter(Boolean) as string[]),
    );
    return ids.map((id) => ({ id, label: profiles[id] ?? id.slice(0, 8) }));
  }, [projects, profiles]);

  const myTasksHref = (uid: string) => {
    const params = new URLSearchParams({ member: uid });
    if (projectFilter !== "all") params.set("project", projectFilter);
    return `/projects-app/my-tasks?${params.toString()}`;
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Users className="h-7 w-7" /> Workload
          </h1>
          <p className="text-muted-foreground">
            Planned vs logged hours per member per week. 40h capacity baseline.
          </p>
        </div>
        <RunProjectReportButton
          projectId="*"
          reportType="project_workload"
          title="Workload report"
          label="Run workload report"
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Project</Label>
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Manager</Label>
          <Select value={managerFilter} onValueChange={setManagerFilter}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All managers</SelectItem>
              {managers.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Branch (current)</Label>
          <div className="text-xs text-muted-foreground border rounded-md px-3 py-2 w-56">
            {currentBusiness?.name ?? "All branches"}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="outline" className="bg-emerald-500/20">&lt;50%</Badge>
        <Badge variant="outline" className="bg-emerald-500/40">50–85%</Badge>
        <Badge variant="outline" className="bg-amber-500/50">85–100%</Badge>
        <Badge variant="outline" className="bg-destructive/60 text-destructive-foreground">Over capacity</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Member × Week</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : members.length === 0 ? (
            <p className="text-sm text-muted-foreground py-12 text-center">
              No members assigned to projects yet.
            </p>
          ) : (
            <table className="min-w-full text-xs border-separate border-spacing-1">
              <thead>
                <tr>
                  <th className="text-left font-medium text-muted-foreground sticky left-0 bg-background pr-2">Member</th>
                  {weeks.map((w) => (
                    <th key={w} className={`text-center font-medium ${w === currentWeek ? "text-primary" : "text-muted-foreground"}`}>
                      {format(new Date(w), "MMM d")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((uid) => (
                  <tr key={uid}>
                    <td className="sticky left-0 bg-background pr-2 font-medium whitespace-nowrap">
                      <Link
                        to={myTasksHref(uid)}
                        className="hover:underline text-primary"
                      >
                        {profiles[uid] ?? uid.slice(0, 8)}
                      </Link>
                    </td>
                    {weeks.map((w) => {
                      const r = byKey.get(`${uid}|${w}`);
                      return (
                        <td key={w} className={`rounded px-2 py-1 text-center min-w-[64px] ${cellClass(r)}`}>
                          {r ? `${r.logged_hours.toFixed(1)}` : "—"}
                          <div className="text-[10px] opacity-70">
                            {r && r.planned_hours > 0 ? `p ${r.planned_hours.toFixed(0)}` : ""}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
