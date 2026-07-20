/**
 * Goals — HR & Manager workspace.
 *
 * Filter by cycle + employee. Bulk-assign a goal to multiple employees at
 * once (the "cascade" pattern). Each row links to the goal detail page
 * where milestones, check-ins, and manager feedback live.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTalentCycles, useTalentGoals, type GoalAlignment, type GoalMeasurement, type GoalStatus } from "@/hooks/useTalent";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, ChevronRight, Target } from "lucide-react";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import {
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

const ALIGNMENTS: GoalAlignment[] = ["organization", "department", "team", "individual"];
const MEASUREMENTS: GoalMeasurement[] = ["percent", "number", "currency", "boolean", "milestone"];
const STATUSES: GoalStatus[] = ["not_started", "in_progress", "at_risk", "completed", "cancelled"];

export default function GoalsPage() {
  const { cycles } = useTalentCycles();
  const { employees } = useEmployees();
  const [cycleId, setCycleId] = useState<string>("");
  const [employeeFilter, setEmployeeFilter] = useState<string>("");

  const { goals, isLoading, assignGoal, updateGoal } = useTalentGoals({
    cycleId: cycleId || undefined,
    employeeId: employeeFilter || undefined,
  });

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, `${e.first_name} ${e.last_name}`])), [employees]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [form, setForm] = useState({
    title: "",
    description: "",
    weight: 100,
    alignment: "individual" as GoalAlignment,
    measurement_type: "percent" as GoalMeasurement,
    target_value: "",
    unit: "",
    category: "",
    target_date: "",
    next_check_in_due_at: "",
  });

  async function submit() {
    if (selected.length === 0 || !form.title) return;
    for (const eid of selected) {
      await assignGoal.mutateAsync({
        employee_id: eid,
        title: form.title,
        description: form.description || undefined,
        cycle_id: cycleId || null,
        weight: Number(form.weight) || 100,
        alignment: form.alignment,
        measurement_type: form.measurement_type,
        target_value: form.target_value ? Number(form.target_value) : null,
        unit: form.unit || null,
        category: form.category || null,
        target_date: form.target_date || null,
        next_check_in_due_at: form.next_check_in_due_at || null,
      });
    }
    setOpen(false);
    setSelected([]);
    setForm({ ...form, title: "", description: "", target_value: "", target_date: "", next_check_in_due_at: "" });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold">Goals</h1>
          <p className="text-sm text-muted-foreground">Assign, cascade, and track goals across the organization.</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:flex-nowrap">
          <Button asChild variant="outline" className="flex-1 sm:flex-none"><Link to="/hr/talent/goals/cascade"><Target className="h-4 w-4 mr-1" /> Cascade view</Link></Button>
          <Button onClick={() => setOpen(true)} className="flex-1 sm:flex-none"><Plus className="h-4 w-4 mr-1" /> Assign goal</Button>
          <TalentFormShell
            open={open}
            onOpenChange={setOpen}
            entity="goal"
            mode="create"
            busy={assignGoal.isPending}
            submitDisabled={!form.title || selected.length === 0}
            submitLabel={`Assign to ${selected.length} employee${selected.length === 1 ? "" : "s"}`}
            onSubmit={submit}
          >
            <WorkflowSheetSection number={1} title="Goal" subtitle="The outcome and the story behind it.">
              <WorkflowField label="Title" required>
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Increase retention by 10%" />
              </WorkflowField>
              <WorkflowField label="Description" hint="Use this to add context, KPIs, or examples reviewers should consider.">
                <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
              </WorkflowField>
            </WorkflowSheetSection>

            <WorkflowSheetSection number={2} title="Measurement" subtitle="How progress will be tracked at check-in time.">
              <WorkflowSheetGrid>
                <WorkflowField label="Alignment">
                  <Select value={form.alignment} onValueChange={(v) => setForm({ ...form, alignment: v as GoalAlignment })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{ALIGNMENTS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
                  </Select>
                </WorkflowField>
                <WorkflowField label="Measured as">
                  <Select value={form.measurement_type} onValueChange={(v) => setForm({ ...form, measurement_type: v as GoalMeasurement })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{MEASUREMENTS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                  </Select>
                </WorkflowField>
              </WorkflowSheetGrid>
              <WorkflowSheetGrid columns={3}>
                <WorkflowField label="Target value">
                  <Input type="number" value={form.target_value} onChange={(e) => setForm({ ...form, target_value: e.target.value })} />
                </WorkflowField>
                <WorkflowField label="Unit">
                  <Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="%, USD, reqs" />
                </WorkflowField>
                <WorkflowField label="Weight (%)">
                  <Input type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} />
                </WorkflowField>
              </WorkflowSheetGrid>
              <WorkflowSheetGrid>
                <WorkflowField label="Target date">
                  <Input type="date" value={form.target_date} onChange={(e) => setForm({ ...form, target_date: e.target.value })} />
                </WorkflowField>
                <WorkflowField label="Next check-in due">
                  <Input type="date" value={form.next_check_in_due_at} onChange={(e) => setForm({ ...form, next_check_in_due_at: e.target.value })} />
                </WorkflowField>
              </WorkflowSheetGrid>
            </WorkflowSheetSection>

            <WorkflowSheetSection
              number={3}
              title="Assignees"
              subtitle="Cascade this goal to one or more employees at once."
              right={<Badge variant="secondary">{selected.length} selected</Badge>}
            >
              <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
                {employees.filter((e) => e.is_active !== false).map((e) => {
                  const checked = selected.includes(e.id);
                  return (
                    <label key={e.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-accent">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => setSelected(v ? [...selected, e.id] : selected.filter((x) => x !== e.id))}
                      />
                      <span>{e.first_name} {e.last_name}</span>
                      <span className="text-xs text-muted-foreground ml-auto">{e.employee_number}</span>
                    </label>
                  );
                })}
              </div>
            </WorkflowSheetSection>
          </TalentFormShell>
        </div>
      </div>


      <Card>

        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <div className="w-full sm:w-auto">
              <Label className="text-xs">Cycle</Label>
              <Select value={cycleId || "all"} onValueChange={(v) => setCycleId(v === "all" ? "" : v)}>
                <SelectTrigger className="w-full sm:w-56 h-9"><SelectValue placeholder="All cycles" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All cycles</SelectItem>
                  {cycles.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="w-full sm:w-auto">
              <Label className="text-xs">Employee</Label>
              <Select value={employeeFilter || "all"} onValueChange={(v) => setEmployeeFilter(v === "all" ? "" : v)}>
                <SelectTrigger className="w-full sm:w-56 h-9"><SelectValue placeholder="All employees" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All employees</SelectItem>
                  {employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.first_name} {e.last_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-2 sm:px-6">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> :
           goals.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Target className="h-8 w-8 mx-auto mb-2 opacity-50" />
              No goals match these filters. Assign one to get started.
            </div>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Goal</TableHead>
                  <TableHead>Alignment</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {goals.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="text-sm">{empById.get(g.employee_id) ?? "—"}</TableCell>
                    <TableCell className="font-medium">{g.title}</TableCell>
                    <TableCell><Badge variant="outline">{g.alignment}</Badge></TableCell>
                    <TableCell className="w-40">
                      <div className="flex items-center gap-2">
                        <Progress value={g.progress_pct ?? 0} className="h-2" />
                        <span className="text-xs text-muted-foreground tabular-nums">{Math.round(g.progress_pct ?? 0)}%</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select value={g.status} onValueChange={(v) => updateGoal.mutate({ id: g.id, patch: { status: v as GoalStatus } })}>
                        <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{g.target_date ?? "—"}</TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="ghost">
                        <Link to={`/hr/talent/goals/${g.id}`}>Open <ChevronRight className="h-3 w-3 ml-1" /></Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
