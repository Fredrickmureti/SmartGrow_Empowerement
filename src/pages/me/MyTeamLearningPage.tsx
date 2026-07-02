/**
 * MyTeamLearning — manager view of direct reports' learning status.
 * Lists each direct report's enrollments, % complete, and overdue items.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useOrganization } from "@/hooks/useOrganization";
import { useTrainingCourses } from "@/hooks/usePerformance";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Users } from "lucide-react";

export default function MyTeamLearningPage() {
  const { currentEmployee } = useCurrentEmployee();
  const { currentOrg } = useOrganization();
  const { courses } = useTrainingCourses();
  const courseById = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);

  const { data: reports = [], isLoading: lr } = useQuery({
    queryKey: ["direct-reports", currentEmployee?.id],
    enabled: !!currentEmployee?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_employees_canonical")
        .select("id, first_name, last_name, job_position")
        .eq("manager_id", currentEmployee!.id);
      if (error) throw error;
      return data ?? [];
    },
  });

  const reportIds = reports.map((r: any) => r.id);

  const { data: enrollments = [], isLoading: le } = useQuery({
    queryKey: ["team-enrollments", currentOrg?.id, reportIds.join(",")],
    enabled: !!currentOrg?.id && reportIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("training_enrollments")
        .select("*")
        .eq("organization_id", currentOrg!.id)
        .in("employee_id", reportIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  if (!currentEmployee) {
    return <Card><CardContent className="py-10 text-center text-muted-foreground">Link your account to an employee profile to view your team.</CardContent></Card>;
  }

  const now = Date.now();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Users className="h-6 w-6" /> Team learning</h1>
        <p className="text-sm text-muted-foreground">Learning progress for your direct reports.</p>
      </div>

      {lr || le ? <p className="text-sm text-muted-foreground">Loading…</p> : reports.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">You don't have any direct reports.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {reports.map((r: any) => {
            const enr = enrollments.filter((e: any) => e.employee_id === r.id);
            const total = enr.filter((e: any) => e.status !== "dropped").length;
            const done = enr.filter((e: any) => e.status === "completed").length;
            const overdue = enr.filter((e: any) => e.due_date && new Date(e.due_date).getTime() < now && e.status !== "completed" && e.status !== "dropped").length;
            const pct = total === 0 ? 0 : Math.round((done / total) * 100);

            return (
              <Card key={r.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">{r.first_name} {r.last_name}</CardTitle>
                      <CardDescription>{r.job_position ?? ""}</CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      {overdue > 0 && <Badge variant="destructive">{overdue} overdue</Badge>}
                      <Badge variant="outline">{done}/{total} done</Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Progress value={pct} />
                  {enr.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No enrollments.</p>
                  ) : (
                    <ul className="text-xs space-y-1">
                      {enr.slice(0, 5).map((e: any) => {
                        const isOverdue = e.due_date && new Date(e.due_date).getTime() < now && e.status !== "completed";
                        return (
                          <li key={e.id} className="flex items-center justify-between gap-2">
                            <span className="truncate">{courseById.get(e.course_id)?.name ?? "—"}</span>
                            <div className="flex items-center gap-1 shrink-0">
                              <Badge variant="outline" className="capitalize text-[10px]">{e.status.replace("_", " ")}</Badge>
                              {e.due_date && (
                                <Badge variant={isOverdue ? "destructive" : "outline"} className="text-[10px]">
                                  {new Date(e.due_date).toLocaleDateString()}
                                </Badge>
                              )}
                            </div>
                          </li>
                        );
                      })}
                      {enr.length > 5 && <li className="text-muted-foreground">+{enr.length - 5} more</li>}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
