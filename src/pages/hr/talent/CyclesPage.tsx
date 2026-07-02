/**
 * Performance Cycles — HR creates cycles, sets phase windows, and advances
 * the cycle through its lifecycle (planning → goal_setting → in_progress →
 * self_review → manager_review → calibration → sign_off → closed).
 */
import { useState } from "react";
import { useTalentCycles, type CyclePhase } from "@/hooks/useTalent";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, ArrowRight, Users, Scale } from "lucide-react";
import { Link } from "react-router-dom";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import {
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

const PHASES: CyclePhase[] = [
  "planning",
  "goal_setting",
  "in_progress",
  "self_review",
  "manager_review",
  "peer_review",
  "calibration",
  "sign_off",
  "closed",
];

export default function CyclesPage() {
  const { cycles, isLoading, createCycle, advancePhase } = useTalentCycles();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    period_start: "",
    period_end: "",
    goal_setting_due_at: "",
    self_review_due_at: "",
    manager_review_due_at: "",
  });

  async function submit() {
    await createCycle.mutateAsync({
      name: form.name,
      description: form.description || undefined,
      period_start: form.period_start,
      period_end: form.period_end,
      goal_setting_due_at: form.goal_setting_due_at || null,
      self_review_due_at: form.self_review_due_at || null,
      manager_review_due_at: form.manager_review_due_at || null,
    });
    setOpen(false);
    setForm({ name: "", description: "", period_start: "", period_end: "", goal_setting_due_at: "", self_review_due_at: "", manager_review_due_at: "" });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Performance Cycles</h1>
          <p className="text-sm text-muted-foreground">A cycle is the container for goals, reviews, and calibration in a period.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> New cycle</Button>
        <TalentFormShell
          open={open}
          onOpenChange={setOpen}
          entity="cycle"
          mode="create"
          busy={createCycle.isPending}
          submitDisabled={!form.name || !form.period_start || !form.period_end}
          submitLabel="Create cycle"
          onSubmit={submit}
        >
          <WorkflowSheetSection number={1} title="Identity" subtitle="What this cycle is called and an optional summary for participants.">
            <WorkflowField label="Cycle name" required>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="2026 H1 Review" />
            </WorkflowField>
            <WorkflowField label="Description" hint="Shown on the participation and sign-off screens.">
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
            </WorkflowField>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={2} title="Review period" subtitle="The window of work being reviewed in this cycle.">
            <WorkflowSheetGrid>
              <WorkflowField label="Period start" required>
                <Input type="date" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} />
              </WorkflowField>
              <WorkflowField label="Period end" required>
                <Input type="date" value={form.period_end} onChange={(e) => setForm({ ...form, period_end: e.target.value })} />
              </WorkflowField>
            </WorkflowSheetGrid>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={3} title="Phase deadlines" subtitle="Optional — used to schedule reminders as the cycle moves through phases.">
            <WorkflowSheetGrid columns={3}>
              <WorkflowField label="Goal setting due">
                <Input type="date" value={form.goal_setting_due_at} onChange={(e) => setForm({ ...form, goal_setting_due_at: e.target.value })} />
              </WorkflowField>
              <WorkflowField label="Self review due">
                <Input type="date" value={form.self_review_due_at} onChange={(e) => setForm({ ...form, self_review_due_at: e.target.value })} />
              </WorkflowField>
              <WorkflowField label="Manager review due">
                <Input type="date" value={form.manager_review_due_at} onChange={(e) => setForm({ ...form, manager_review_due_at: e.target.value })} />
              </WorkflowField>
            </WorkflowSheetGrid>
          </WorkflowSheetSection>
        </TalentFormShell>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> :
        cycles.length === 0 ? (
          <Card><CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground mb-3">No cycles yet. Cycles drive every other talent surface — start here.</p>
            <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> New cycle</Button>
          </CardContent></Card>
        ) : (
          <div className="grid gap-3">
            {cycles.map((c) => {
              const idx = PHASES.indexOf(c.phase);
              const nextPhase = PHASES[idx + 1];
              return (
                <Card key={c.id}>
                  <CardHeader className="flex flex-row items-start justify-between space-y-0">
                    <div>
                      <CardTitle className="text-lg">{c.name}</CardTitle>
                      <CardDescription>{c.period_start} → {c.period_end}{c.description ? ` · ${c.description}` : ""}</CardDescription>
                    </div>
                    <Badge variant="secondary">{c.phase.replace(/_/g, " ")}</Badge>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {c.goal_setting_due_at ? <Pill label="Goal setting due" value={fmtDate(c.goal_setting_due_at)} /> : null}
                    {c.self_review_due_at ? <Pill label="Self review due" value={fmtDate(c.self_review_due_at)} /> : null}
                    {c.manager_review_due_at ? <Pill label="Manager review due" value={fmtDate(c.manager_review_due_at)} /> : null}
                    <div className="ml-auto flex items-center gap-2">
                      <Button asChild size="sm" variant="ghost"><Link to={`/hr/talent/cycles/${c.id}/participation`}><Users className="h-3 w-3 mr-1" />Participation</Link></Button>
                      <Button asChild size="sm" variant="ghost"><Link to={`/hr/talent/cycles/${c.id}/calibration`}><Scale className="h-3 w-3 mr-1" />Calibration</Link></Button>
                      <Select value={c.phase} onValueChange={(v) => advancePhase.mutate({ id: c.id, phase: v as CyclePhase })}>
                        <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>{PHASES.map((p) => <SelectItem key={p} value={p}>{p.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
                      </Select>
                      {nextPhase ? (
                        <Button size="sm" variant="outline" onClick={() => advancePhase.mutate({ id: c.id, phase: nextPhase })}>
                          Advance <ArrowRight className="h-3 w-3 ml-1" />
                        </Button>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
    </div>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5">{label}: <strong className="text-foreground">{value}</strong></span>;
}
function fmtDate(s: string) {
  try { return new Date(s).toLocaleDateString(); } catch { return s; }
}
