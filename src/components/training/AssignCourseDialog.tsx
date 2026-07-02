/**
 * AssignCourseDialog — bulk assign a course to employees by individual pick,
 * department, job position, or "all active". Mirrors Workday/SuccessFactors
 * bulk-assignment ergonomics.
 */
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useEmployees } from "@/hooks/useEmployees";
import { useDepartments } from "@/hooks/useDepartments";
import { useTrainingCourses, useTrainingEnrollments } from "@/hooks/usePerformance";

export function AssignCourseDialog({ open, onOpenChange, preselectedCourseId }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  preselectedCourseId?: string;
}) {
  const { courses } = useTrainingCourses();
  const { employees } = useEmployees();
  const { departments } = useDepartments();
  const { bulkEnroll } = useTrainingEnrollments();

  const [courseId, setCourseId] = useState(preselectedCourseId ?? "");
  const [due, setDue] = useState<string>("");
  const [tab, setTab] = useState<"people" | "department" | "all">("people");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deptId, setDeptId] = useState<string>("");

  const activeEmps = useMemo(() => employees.filter((e: any) => e.is_active !== false), [employees]);

  function toggle(id: string) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  function resolveIds(): string[] {
    if (tab === "people") return Array.from(selected);
    if (tab === "department") return activeEmps.filter((e: any) => e.department_id === deptId).map((e) => e.id);
    return activeEmps.map((e) => e.id);
  }

  const ids = resolveIds();
  const ready = !!courseId && ids.length > 0;

  async function submit() {
    await bulkEnroll.mutateAsync({ employee_ids: ids, course_id: courseId, due_date: due || null });
    onOpenChange(false);
    setSelected(new Set()); setDeptId(""); setDue("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Assign course</DialogTitle>
          <DialogDescription>Enroll many employees at once. Anyone already actively enrolled is skipped.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Course</Label>
              <Select value={courseId} onValueChange={setCourseId}>
                <SelectTrigger><SelectValue placeholder="Select course" /></SelectTrigger>
                <SelectContent>
                  {courses.filter((c) => c.status !== "archived").map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Due date (optional)</Label>
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
            <TabsList>
              <TabsTrigger value="people">People</TabsTrigger>
              <TabsTrigger value="department">Department</TabsTrigger>
              <TabsTrigger value="all">All active</TabsTrigger>
            </TabsList>
            <TabsContent value="people">
              <ScrollArea className="h-64 border rounded-md p-2">
                {activeEmps.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 py-1 text-sm cursor-pointer">
                    <Checkbox checked={selected.has(e.id)} onCheckedChange={() => toggle(e.id)} />
                    {e.first_name} {e.last_name}
                  </label>
                ))}
              </ScrollArea>
              <p className="text-xs text-muted-foreground mt-1">{selected.size} selected</p>
            </TabsContent>
            <TabsContent value="department">
              <Select value={deptId} onValueChange={setDeptId}>
                <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>{departments.map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">{ids.length} employees in this department</p>
            </TabsContent>
            <TabsContent value="all">
              <p className="text-sm">This will enroll all <strong>{activeEmps.length}</strong> active employees.</p>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!ready || bulkEnroll.isPending}>
            {bulkEnroll.isPending ? "Assigning…" : `Assign to ${ids.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
