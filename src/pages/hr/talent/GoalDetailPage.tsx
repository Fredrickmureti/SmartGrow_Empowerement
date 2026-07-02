/**
 * Goal Detail — single-pane view of a goal with its milestones, check-in
 * history, and manager-feedback affordance. Used by HR and managers.
 * Employees see a sibling component at /me/talent/goals/:id.
 */
import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useTalentGoal, type GoalStatus, type MilestoneStatus } from "@/hooks/useTalent";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Plus, MessageSquare, CheckCircle2 } from "lucide-react";

const MILESTONE_STATUS: MilestoneStatus[] = ["pending", "in_progress", "done", "skipped"];
const GOAL_STATUS: GoalStatus[] = ["not_started", "in_progress", "at_risk", "completed", "cancelled"];

export default function GoalDetailPage() {
  const { goalId } = useParams();
  const { goal, milestones, updates, isLoading, addMilestone, updateMilestone, addManagerFeedback } = useTalentGoal(goalId);
  const { employees } = useEmployees();
  const empName = goal ? employees.find((e) => e.id === goal.employee_id) : null;

  const [m, setM] = useState({ title: "", due_date: "", weight: 0 });
  const [fb, setFb] = useState({ comment: "", rating: "", status: "" });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!goal) return <p className="text-sm text-muted-foreground">Goal not found.</p>;

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm"><Link to="/hr/talent/goals"><ArrowLeft className="h-4 w-4 mr-1" /> Back to goals</Link></Button>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-xl">{goal.title}</CardTitle>
              <CardDescription>
                {empName ? `${empName.first_name} ${empName.last_name}` : "—"} ·{" "}
                <Badge variant="outline" className="ml-1">{goal.alignment}</Badge>{" "}
                <Badge variant="secondary" className="ml-1">{goal.measurement_type}</Badge>
              </CardDescription>
            </div>
            <Badge>{goal.status.replace(/_/g, " ")}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {goal.description ? <p className="text-sm">{goal.description}</p> : null}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Field label="Progress">
              <div className="flex items-center gap-2"><Progress value={goal.progress_pct} className="h-2" /><span className="tabular-nums text-xs">{Math.round(goal.progress_pct ?? 0)}%</span></div>
            </Field>
            <Field label="Target">{goal.target_value ?? "—"} {goal.unit ?? ""}</Field>
            <Field label="Current">{goal.current_value ?? "—"} {goal.unit ?? ""}</Field>
            <Field label="Target date">{goal.target_date ?? "—"}</Field>
            <Field label="Weight">{goal.weight}%</Field>
            <Field label="Last check-in">{goal.last_check_in_at ? new Date(goal.last_check_in_at).toLocaleDateString() : "—"}</Field>
            <Field label="Next check-in due">{goal.next_check_in_due_at ? new Date(goal.next_check_in_due_at).toLocaleDateString() : "—"}</Field>
            <Field label="Final rating">{goal.final_rating ?? "—"}</Field>
          </div>
          {goal.manager_comment ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium mb-1 flex items-center gap-1"><MessageSquare className="h-4 w-4" /> Manager comment</p>
              <p className="text-muted-foreground whitespace-pre-wrap">{goal.manager_comment}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Milestones</CardTitle><CardDescription>Checkpoints inside this goal.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {milestones.length === 0 ? <p className="text-xs text-muted-foreground">No milestones yet.</p> : null}
            {milestones.map((ms) => (
              <div key={ms.id} className="flex items-center gap-2 rounded border px-2 py-1.5">
                <span className={"flex-1 text-sm " + (ms.status === "done" ? "line-through text-muted-foreground" : "")}>{ms.title}</span>
                {ms.due_date ? <span className="text-xs text-muted-foreground">{ms.due_date}</span> : null}
                <Select value={ms.status} onValueChange={(v) => updateMilestone.mutate({ id: ms.id, patch: { status: v as MilestoneStatus } })}>
                  <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{MILESTONE_STATUS.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            ))}
            <div className="border-t pt-2 mt-2 grid grid-cols-[1fr_120px_70px_auto] gap-2 items-end">
              <div><Label className="text-xs">Title</Label><Input value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} placeholder="New milestone" className="h-8" /></div>
              <div><Label className="text-xs">Due</Label><Input type="date" value={m.due_date} onChange={(e) => setM({ ...m, due_date: e.target.value })} className="h-8" /></div>
              <div><Label className="text-xs">Weight</Label><Input type="number" value={m.weight} onChange={(e) => setM({ ...m, weight: Number(e.target.value) })} className="h-8" /></div>
              <Button size="sm" disabled={!m.title} onClick={async () => { await addMilestone.mutateAsync({ title: m.title, due_date: m.due_date || null, weight: m.weight, sort_order: milestones.length }); setM({ title: "", due_date: "", weight: 0 }); }}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Manager feedback</CardTitle><CardDescription>Notifies the employee and writes to the goal history.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <Textarea value={fb.comment} onChange={(e) => setFb({ ...fb, comment: e.target.value })} placeholder="Strengths, blockers, next focus…" rows={4} />
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Set status</Label>
                <Select value={fb.status || "unchanged"} onValueChange={(v) => setFb({ ...fb, status: v === "unchanged" ? "" : v })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Keep status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unchanged">Keep status</SelectItem>
                    {GOAL_STATUS.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div><Label className="text-xs">Rating (0–5)</Label><Input type="number" min={0} max={5} step={0.5} value={fb.rating} onChange={(e) => setFb({ ...fb, rating: e.target.value })} className="h-8" /></div>
            </div>
            <Button
              disabled={!fb.comment || addManagerFeedback.isPending}
              onClick={async () => {
                await addManagerFeedback.mutateAsync({
                  comment: fb.comment,
                  rating: fb.rating ? Number(fb.rating) : null,
                  status: (fb.status as GoalStatus) || undefined,
                });
                setFb({ comment: "", rating: "", status: "" });
              }}
            >
              <MessageSquare className="h-4 w-4 mr-1" /> Send feedback
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Activity</CardTitle><CardDescription>Check-ins, feedback, and milestone events.</CardDescription></CardHeader>
        <CardContent>
          {updates.length === 0 ? <p className="text-xs text-muted-foreground">No activity yet.</p> : (
            <ul className="space-y-3">
              {updates.map((u) => (
                <li key={u.id} className="flex gap-3 text-sm">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                    {u.update_type === "check_in" ? <CheckCircle2 className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
                  </div>
                  <div className="flex-1">
                    <div className="flex gap-2 items-center">
                      <Badge variant="outline" className="text-[10px]">{u.update_type.replace(/_/g, " ")}</Badge>
                      {u.author_role ? <span className="text-xs text-muted-foreground">{u.author_role}</span> : null}
                      {u.progress_pct != null ? <span className="text-xs text-muted-foreground">→ {Math.round(u.progress_pct)}%</span> : null}
                      <span className="ml-auto text-xs text-muted-foreground">{new Date(u.created_at).toLocaleString()}</span>
                    </div>
                    {u.comment ? <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{u.comment}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}
