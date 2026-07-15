/**
 * My Goal Detail — employee-facing goal view with check-in form, milestone
 * progress toggles, and read-only manager feedback + activity history.
 *
 * Companion to /hr/talent/goals/:id (manager view). Both share the same
 * useTalentGoal hook and same data; just shaped for the audience.
 */
import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useTalentGoal, type MilestoneStatus } from "@/hooks/useTalent";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, CheckCircle2, MessageSquare } from "lucide-react";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";

const MILESTONE_STATUS: MilestoneStatus[] = ["pending", "in_progress", "done", "skipped"];

export default function MyGoalDetail() {
  const { goalId } = useParams();
  const { goal, milestones, updates, isLoading, updateMilestone, checkIn } = useTalentGoal(goalId);
  const [pct, setPct] = useState<number | null>(null);
  const [comment, setComment] = useState("");

  if (isLoading) return (<><PageHeader title="Goal" /><PageBody><LoadingState /></PageBody></>);
  if (!goal) return (<><PageHeader title="Goal" /><PageBody><EmptyState title="Goal not found" /></PageBody></>);

  const sliderValue = pct ?? goal.progress_pct ?? 0;

  return (
    <>
      <PageHeader
        title={goal.title}
        description={goal.description ?? undefined}
        actions={<Button asChild variant="ghost" size="sm"><Link to="/me/talent/goals"><ArrowLeft className="h-4 w-4 mr-1" /> Back to my goals</Link></Button>}
      />
      <PageBody>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-base">Snapshot</CardTitle>
            </div>
            <Badge>{goal.status.replace(/_/g, " ")}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Progress"><div className="flex items-center gap-2"><Progress value={goal.progress_pct} className="h-2" /><span className="tabular-nums text-xs">{Math.round(goal.progress_pct ?? 0)}%</span></div></Field>
            <Field label="Target">{goal.target_value ?? "—"} {goal.unit ?? ""}</Field>
            <Field label="Target date">{goal.target_date ?? "—"}</Field>
            <Field label="Weight">{goal.weight}%</Field>
          </div>
          {goal.manager_comment ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium mb-1 flex items-center gap-1"><MessageSquare className="h-4 w-4" /> Manager feedback</p>
              <p className="text-muted-foreground whitespace-pre-wrap">{goal.manager_comment}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Submit a check-in</CardTitle><CardDescription>This notifies your manager and is added to the goal history.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">Progress ({Math.round(sliderValue)}%)</Label>
            <Slider value={[sliderValue]} onValueChange={(v) => setPct(v[0])} max={100} step={5} className="mt-2" />
          </div>
          <div>
            <Label className="text-xs">What happened since the last check-in?</Label>
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={4} placeholder="Wins, blockers, what you'll do next…" />
          </div>
          <Button
            disabled={checkIn.isPending || pct === null}
            onClick={async () => {
              await checkIn.mutateAsync({ progress_pct: pct ?? goal.progress_pct ?? 0, comment: comment || undefined });
              setPct(null);
              setComment("");
            }}
          >
            <CheckCircle2 className="h-4 w-4 mr-1" /> Submit check-in
          </Button>
        </CardContent>
      </Card>

      {milestones.length > 0 ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Milestones</CardTitle></CardHeader>
          <CardContent className="space-y-2">
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
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle className="text-base">Activity</CardTitle></CardHeader>
        <CardContent>
          {updates.length === 0 ? <p className="text-xs text-muted-foreground">No activity yet — submit your first check-in above.</p> : (
            <ul className="space-y-3">
              {updates.map((u) => (
                <li key={u.id} className="flex gap-3 text-sm">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                    {u.update_type === "check_in" ? <CheckCircle2 className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
                  </div>
                  <div className="flex-1">
                    <div className="flex gap-2 items-center">
                      <Badge variant="outline" className="text-[10px]">{u.update_type.replace(/_/g, " ")}</Badge>
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
      </PageBody>
    </>
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
