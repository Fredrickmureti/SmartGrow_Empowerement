/**
 * LearningReportsPage — HR reporting surface for the training module.
 * Shows completion rate per course, overdue list, and per-department compliance.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useTrainingCourses, useTrainingEnrollments } from "@/hooks/usePerformance";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { BarChart3 } from "lucide-react";

export default function LearningReportsPage() {
  const { currentOrg } = useOrganization();
  const { courses } = useTrainingCourses();
  const { enrollments } = useTrainingEnrollments();
  const { employees } = useEmployees();
  const empById = useMemo(() => new Map(employees.map((e: any) => [e.id, e])), [employees]);
  const courseById = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);

  const { data: departments = [] } = useQuery({
    queryKey: ["departments-for-learning", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data } = await supabase.from("departments").select("id,name").eq("organization_id", currentOrg!.id);
      return data ?? [];
    },
  });

  const now = Date.now();

  const perCourse = useMemo(() => courses.map((c) => {
    const rows = enrollments.filter((e) => e.course_id === c.id && e.status !== "dropped");
    const done = rows.filter((e) => e.status === "completed").length;
    const failed = rows.filter((e) => e.status === "failed").length;
    return { course: c, total: rows.length, done, failed, pct: rows.length === 0 ? 0 : Math.round((done / rows.length) * 100) };
  }).sort((a, b) => b.total - a.total), [courses, enrollments]);

  const overdue = useMemo(() => enrollments
    .filter((e) => e.due_date && new Date(e.due_date).getTime() < now && e.status !== "completed" && e.status !== "dropped" && e.status !== "failed")
    .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1)),
    [enrollments, now]);

  const perDept = useMemo(() => departments.map((d: any) => {
    const empsInDept = employees.filter((e: any) => e.department_id === d.id);
    const ids = new Set(empsInDept.map((e) => e.id));
    const rows = enrollments.filter((e) => ids.has(e.employee_id) && e.status !== "dropped");
    const done = rows.filter((e) => e.status === "completed").length;
    const pct = rows.length === 0 ? 0 : Math.round((done / rows.length) * 100);
    return { dept: d, headcount: empsInDept.length, enrollments: rows.length, done, pct };
  }), [departments, employees, enrollments]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><BarChart3 className="h-6 w-6" /> Learning reports</h1>
        <p className="text-sm text-muted-foreground">Completion, compliance, and overdue training across the organization.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Completion by course</CardTitle><CardDescription>Across all non-dropped enrollments.</CardDescription></CardHeader>
        <CardContent>
          {perCourse.length === 0 ? <p className="text-sm text-muted-foreground">No data.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Course</TableHead><TableHead>Total</TableHead><TableHead>Completed</TableHead><TableHead>Failed</TableHead><TableHead className="w-48">Rate</TableHead></TableRow></TableHeader>
              <TableBody>{perCourse.map((r) => (
                <TableRow key={r.course.id}>
                  <TableCell className="font-medium">{r.course.name}</TableCell>
                  <TableCell>{r.total}</TableCell>
                  <TableCell>{r.done}</TableCell>
                  <TableCell>{r.failed}</TableCell>
                  <TableCell><div className="flex items-center gap-2"><Progress value={r.pct} className="w-32" /><span className="text-xs">{r.pct}%</span></div></TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Overdue</CardTitle><CardDescription>Enrollments past their due date and not yet completed.</CardDescription></CardHeader>
        <CardContent>
          {overdue.length === 0 ? <p className="text-sm text-muted-foreground">Nothing overdue. 🎉</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Course</TableHead><TableHead>Due</TableHead><TableHead>Days late</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>{overdue.map((e) => {
                const emp = empById.get(e.employee_id) as any;
                const days = Math.floor((now - new Date(e.due_date!).getTime()) / (1000 * 60 * 60 * 24));
                return (
                  <TableRow key={e.id}>
                    <TableCell>{emp ? `${emp.first_name} ${emp.last_name}` : "—"}</TableCell>
                    <TableCell>{courseById.get(e.course_id)?.name ?? "—"}</TableCell>
                    <TableCell className="text-xs">{new Date(e.due_date!).toLocaleDateString()}</TableCell>
                    <TableCell><Badge variant="destructive">{days}d</Badge></TableCell>
                    <TableCell><Badge variant="outline" className="capitalize">{e.status.replace("_", " ")}</Badge></TableCell>
                  </TableRow>
                );
              })}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Compliance by department</CardTitle><CardDescription>Completion rate of assigned learning per department.</CardDescription></CardHeader>
        <CardContent>
          {perDept.length === 0 ? <p className="text-sm text-muted-foreground">No departments.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Department</TableHead><TableHead>Headcount</TableHead><TableHead>Enrollments</TableHead><TableHead>Completed</TableHead><TableHead className="w-48">Rate</TableHead></TableRow></TableHeader>
              <TableBody>{perDept.map((r) => (
                <TableRow key={r.dept.id}>
                  <TableCell className="font-medium">{r.dept.name}</TableCell>
                  <TableCell>{r.headcount}</TableCell>
                  <TableCell>{r.enrollments}</TableCell>
                  <TableCell>{r.done}</TableCell>
                  <TableCell><div className="flex items-center gap-2"><Progress value={r.pct} className="w-32" /><span className="text-xs">{r.pct}%</span></div></TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
