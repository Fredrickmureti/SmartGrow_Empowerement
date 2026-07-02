/**
 * MyLearningPathsPage — Phase G learner surface. Browse active learning
 * paths, self-enroll, and track progress against the path's course sequence.
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { GraduationCap, Play, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

const sb = supabase as any;

export default function MyLearningPathsPage() {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: meEmp } = useQuery({
    queryKey: ["me-employee-id", currentOrg?.id, user?.id],
    enabled: !!currentOrg?.id && !!user?.id,
    queryFn: async () => {
      const { data } = await sb.from("v_employees_canonical").select("id").eq("organization_id", currentOrg!.id).eq("user_id", user!.id).maybeSingle();
      return data?.id as string | undefined;
    },
  });

  const { data: paths = [], isLoading } = useQuery({
    queryKey: ["me-learning-paths", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await sb
        .from("learning_paths")
        .select("*, learning_path_courses(id, sequence_no, is_required, course_id, training_courses(id,name,duration_hours))")
        .eq("organization_id", currentOrg!.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: enrollments = [] } = useQuery({
    queryKey: ["me-path-enrollments", meEmp],
    enabled: !!meEmp,
    queryFn: async () => {
      const { data, error } = await sb
        .from("learning_path_enrollments")
        .select("*")
        .eq("employee_id", meEmp);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: courseEnrolls = [] } = useQuery({
    queryKey: ["me-course-enrollments", meEmp],
    enabled: !!meEmp,
    queryFn: async () => {
      const { data, error } = await sb
        .from("training_enrollments")
        .select("id, course_id, status, score, completed_at")
        .eq("employee_id", meEmp);
      if (error) throw error;
      return data ?? [];
    },
  });

  const enroll = useMutation({
    mutationFn: async (pathId: string) => {
      const { error } = await sb.from("learning_path_enrollments").insert({
        organization_id: currentOrg!.id, path_id: pathId, employee_id: meEmp, status: "enrolled",
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Enrolled"); qc.invalidateQueries({ queryKey: ["me-path-enrollments"] }); },
    onError: (e: any) => toast.error(e.message ?? "Failed"),
  });

  const enrollMap = new Map((enrollments as any[]).map(e => [e.path_id, e]));
  const courseMap = new Map((courseEnrolls as any[]).map(c => [c.course_id, c]));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><GraduationCap className="h-5 w-5" /> Learning paths</CardTitle>
        <CardDescription>Curated sequences to grow into your next role.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {!isLoading && !paths.length && <div className="text-sm text-muted-foreground">No active paths yet.</div>}
        {(paths as any[]).map(p => {
          const enr = enrollMap.get(p.id);
          const courses = (p.learning_path_courses ?? []).sort((a: any, b: any) => a.sequence_no - b.sequence_no);
          const completed = courses.filter((c: any) => courseMap.get(c.course_id)?.status === "completed").length;
          const pct = courses.length ? Math.round((completed / courses.length) * 100) : 0;
          return (
            <div key={p.id} className="border rounded-lg p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{p.name}</span>
                    {p.target_role && <Badge variant="outline">{p.target_role}</Badge>}
                  </div>
                  {p.description && <div className="text-sm text-muted-foreground mt-1">{p.description}</div>}
                </div>
                {enr ? <Badge>{enr.status}</Badge>
                  : <Button size="sm" disabled={!meEmp} onClick={() => enroll.mutate(p.id)}>
                      <Play className="h-4 w-4 mr-1" /> Enroll
                    </Button>}
              </div>
              {enr && (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{completed}/{courses.length} complete</span>
                    <Progress value={pct} className="h-2 flex-1" />
                    <span>{pct}%</span>
                  </div>
                  <ol className="space-y-1">
                    {courses.map((c: any, i: number) => {
                      const ce = courseMap.get(c.course_id);
                      const done = ce?.status === "completed";
                      return (
                        <li key={c.id} className="flex items-center gap-2 text-sm">
                          {done ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <span className="w-4 h-4 rounded-full border" />}
                          <span className="text-muted-foreground">#{i + 1}</span>
                          <span className={done ? "line-through text-muted-foreground" : ""}>{c.training_courses?.name ?? c.course_id}</span>
                          {c.is_required && <Badge variant="outline" className="text-xs">required</Badge>}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
