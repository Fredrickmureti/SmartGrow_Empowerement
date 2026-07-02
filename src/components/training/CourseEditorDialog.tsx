/**
 * CourseEditorDialog — full edit experience for a training course.
 * Tabs: Details · Materials · Enrollments.
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CourseMaterialsManager } from "./CourseMaterialsManager";
import { useTrainingCourses, useTrainingEnrollments, type TrainingCourse, type CourseStatus } from "@/hooks/usePerformance";
import { useEmployees } from "@/hooks/useEmployees";

const STATUSES: CourseStatus[] = ["draft", "published", "archived"];
const DELIVERY_MODES = ["self_paced", "instructor_led", "external", "blended"] as const;

export function CourseEditorDialog({ course, open, onOpenChange }: {
  course: TrainingCourse;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { updateCourse } = useTrainingCourses();
  const { enrollments } = useTrainingEnrollments();
  const { employees } = useEmployees();
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, `${e.first_name} ${e.last_name}`])), [employees]);
  const courseEnrollments = useMemo(() => enrollments.filter((e) => e.course_id === course.id), [enrollments, course.id]);

  const [form, setForm] = useState<Partial<TrainingCourse>>(course);
  useEffect(() => { setForm(course); }, [course]);

  async function save() {
    const patch: Partial<TrainingCourse> = {
      name: form.name,
      description: form.description ?? null,
      objectives: form.objectives ?? null,
      provider: form.provider ?? null,
      duration_hours: form.duration_hours ?? null,
      category: form.category ?? null,
      delivery_mode: form.delivery_mode ?? null,
      status: form.status as CourseStatus,
      requires_certificate: !!form.requires_certificate,
      pass_score: form.pass_score ?? null,
      recertify_months: form.recertify_months ?? null,
      is_self_enroll: !!form.is_self_enroll,
    };
    await updateCourse.mutateAsync({ id: course.id, patch });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {course.name}
            <Badge variant="outline" className="capitalize">{form.status ?? course.status}</Badge>
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="materials">Materials</TabsTrigger>
            <TabsTrigger value="enrollments">Enrollments ({courseEnrollments.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="details" className="space-y-3 pt-3">
            <div><Label>Name</Label><Input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><Label>Description</Label><Textarea value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div><Label>Learning objectives</Label><Textarea rows={3} value={form.objectives ?? ""} onChange={(e) => setForm({ ...form, objectives: e.target.value })} placeholder="What will learners be able to do after completing this?" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Provider</Label><Input value={form.provider ?? ""} onChange={(e) => setForm({ ...form, provider: e.target.value })} /></div>
              <div><Label>Category</Label><Input value={form.category ?? ""} onChange={(e) => setForm({ ...form, category: e.target.value })} /></div>
              <div><Label>Duration (hours)</Label><Input type="number" step="0.5" value={form.duration_hours ?? ""} onChange={(e) => setForm({ ...form, duration_hours: e.target.value ? Number(e.target.value) : null })} /></div>
              <div><Label>Delivery</Label>
                <Select value={form.delivery_mode ?? ""} onValueChange={(v) => setForm({ ...form, delivery_mode: v })}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{DELIVERY_MODES.map((m) => <SelectItem key={m} value={m}>{m.replace("_", " ")}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Status</Label>
                <Select value={form.status ?? "published"} onValueChange={(v) => setForm({ ...form, status: v as CourseStatus })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Pass score (optional)</Label><Input type="number" step="0.1" value={form.pass_score ?? ""} onChange={(e) => setForm({ ...form, pass_score: e.target.value ? Number(e.target.value) : null })} /></div>
              <div><Label>Re-certify every (months)</Label><Input type="number" min={1} value={form.recertify_months ?? ""} onChange={(e) => setForm({ ...form, recertify_months: e.target.value ? Number(e.target.value) : null })} placeholder="e.g. 12" /></div>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Require completion certificate</p>
                <p className="text-xs text-muted-foreground">Learners must upload a certificate file to mark complete.</p>
              </div>
              <Switch checked={!!form.requires_certificate} onCheckedChange={(v) => setForm({ ...form, requires_certificate: v })} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Visible in learner catalog (self-enroll)</p>
                <p className="text-xs text-muted-foreground">Employees can discover and enroll themselves from /me/learning/catalog.</p>
              </div>
              <Switch checked={!!form.is_self_enroll} onCheckedChange={(v) => setForm({ ...form, is_self_enroll: v })} />
            </div>
          </TabsContent>

          <TabsContent value="materials" className="pt-3">
            <CourseMaterialsManager courseId={course.id} />
          </TabsContent>

          <TabsContent value="enrollments" className="pt-3">
            {courseEnrollments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No one is enrolled in this course yet.</p>
            ) : (
              <Table>
                <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Status</TableHead><TableHead>Score</TableHead><TableHead>Completed</TableHead></TableRow></TableHeader>
                <TableBody>
                  {courseEnrollments.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{empById.get(e.employee_id) ?? "—"}</TableCell>
                      <TableCell><Badge variant="outline" className="capitalize">{e.status.replace("_", " ")}</Badge></TableCell>
                      <TableCell className="text-xs">{e.score ?? "—"}</TableCell>
                      <TableCell className="text-xs">{e.completed_at ? new Date(e.completed_at).toLocaleDateString() : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={save} disabled={!form.name || updateCourse.isPending}>{updateCourse.isPending ? "Saving…" : "Save changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
