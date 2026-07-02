/**
 * Calibration — Phase C:
 *   1. Rating distribution across submitted manager reviews in a cycle.
 *   2. Calibration sessions (scheduled group meetings) with status + scheduling.
 *   3. Per-review adjustment proposals (with rationale) that HR can approve;
 *      approving applies the new final_rating via the
 *      `talent_calibration_apply_adjustment` RPC.
 *   4. Bulk-create missing self/manager reviews for the cycle scope.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTalentCycles } from "@/hooks/useTalent";
import { useReviews } from "@/hooks/useReviews";
import { useEmployees } from "@/hooks/useEmployees";
import {
  useCalibrationSessions,
  useCalibrationAdjustments,
  useBulkCreateReviews,
  type CalibrationSession,
} from "@/hooks/useCalibration";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import {
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { ArrowLeft, CalendarPlus, CheckCircle2, Plus, Scale, UserPlus2, XCircle } from "lucide-react";

const RATING_BUCKETS = [1, 2, 3, 4, 5];

export default function CalibrationPage() {
  const { cycleId } = useParams();
  const { cycles } = useTalentCycles();
  const { reviews, isLoading } = useReviews({ cycleId });
  const { employees } = useEmployees();
  const { sessions, createSession } = useCalibrationSessions(cycleId);
  const { adjustments, propose, apply, reject } = useCalibrationAdjustments({ cycleId });
  const bulkCreate = useBulkCreateReviews();

  const cycle = cycles.find((c) => c.id === cycleId);

  const managerReviews = useMemo(
    () => reviews.filter((r: any) =>
      r.review_type === "manager" &&
      ["submitted", "calibrated", "signed_off", "acknowledged"].includes(r.status),
    ),
    [reviews],
  );

  const distribution = useMemo(() => {
    const counts = new Map<number, number>();
    RATING_BUCKETS.forEach((b) => counts.set(b, 0));
    managerReviews.forEach((r: any) => {
      const v = Math.round(r.final_rating ?? r.overall_rating ?? 0);
      if (v >= 1 && v <= 5) counts.set(v, (counts.get(v) ?? 0) + 1);
    });
    const total = managerReviews.length || 1;
    return RATING_BUCKETS.map((b) => ({
      bucket: b,
      n: counts.get(b) ?? 0,
      pct: ((counts.get(b) ?? 0) / total) * 100,
    }));
  }, [managerReviews]);

  const empName = (id: string) => {
    const e = employees.find((x: any) => x.id === id);
    return e ? `${e.first_name} ${e.last_name}` : id.slice(0, 8);
  };

  const pendingByReview = useMemo(() => {
    const m = new Map<string, typeof adjustments[number]>();
    adjustments.forEach((a) => { if (a.decision === "pending") m.set(a.review_id, a); });
    return m;
  }, [adjustments]);

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm">
        <Link to="/hr/talent/cycles"><ArrowLeft className="h-4 w-4 mr-1" /> Back to cycles</Link>
      </Button>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Scale className="h-5 w-5" /> Calibration</h1>
          <p className="text-sm text-muted-foreground">
            {cycle ? <>Cycle <strong>{cycle.name}</strong> — propose, debate, and approve final ratings before sign-off.</> : "Cycle not found"}
          </p>
        </div>
        {cycleId ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => bulkCreate.mutate({ cycle_id: cycleId, review_type: "self" })} disabled={bulkCreate.isPending}>
              <Plus className="h-3 w-3 mr-1" /> Self reviews
            </Button>
            <Button size="sm" variant="outline" onClick={() => bulkCreate.mutate({ cycle_id: cycleId, review_type: "manager" })} disabled={bulkCreate.isPending}>
              <Plus className="h-3 w-3 mr-1" /> Manager reviews
            </Button>
          </div>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rating distribution</CardTitle>
          <CardDescription>Across {managerReviews.length} manager review{managerReviews.length === 1 ? "" : "s"}. Healthy distributions trend toward the middle.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {distribution.map((d) => (
              <div key={d.bucket} className="flex items-center gap-3">
                <span className="w-8 text-xs text-muted-foreground tabular-nums">{d.bucket} ★</span>
                <div className="flex-1 h-3 rounded bg-muted overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: `${d.pct}%` }} />
                </div>
                <span className="w-20 text-xs tabular-nums text-right">{d.n} · {d.pct.toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {cycleId ? <SessionsCard cycleId={cycleId} sessions={sessions} onCreate={createSession.mutateAsync} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reviews & adjustments</CardTitle>
          <CardDescription>Propose an adjustment with rationale. HR approves to apply the new final rating.</CardDescription>
        </CardHeader>
        <CardContent className="p-0 overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left">Employee</th>
                <th className="px-3 py-2 text-left">Manager</th>
                <th className="px-3 py-2 text-left">Final</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Pending proposal</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
              ) : managerReviews.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No submitted manager reviews yet.</td></tr>
              ) : managerReviews.map((r: any) => {
                const pending = pendingByReview.get(r.id);
                return (
                  <tr key={r.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2">{empName(r.employee_id)}</td>
                    <td className="px-3 py-2 tabular-nums">{r.overall_rating ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums">{r.final_rating != null ? r.final_rating : <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-2"><Badge variant="outline">{r.status.replace(/_/g, " ")}</Badge></td>
                    <td className="px-3 py-2 text-xs">
                      {pending ? <span className="text-amber-600">→ {pending.proposed_rating} ({pending.rationale.slice(0, 40)}{pending.rationale.length > 40 ? "…" : ""})</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {pending ? (
                        <div className="inline-flex gap-1">
                          <Button size="sm" variant="default" onClick={() => apply.mutate(pending.id)} disabled={apply.isPending}>
                            <CheckCircle2 className="h-3 w-3 mr-1" /> Approve
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => reject.mutate(pending.id)} disabled={reject.isPending}>
                            <XCircle className="h-3 w-3 mr-1" /> Reject
                          </Button>
                        </div>
                      ) : (
                        <ProposeDialog
                          reviewId={r.id}
                          cycleId={cycleId!}
                          employeeId={r.employee_id}
                          originalRating={r.final_rating ?? r.overall_rating ?? null}
                          sessions={sessions}
                          onPropose={(payload) => propose.mutateAsync(payload)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function SessionsCard({
  cycleId, sessions, onCreate,
}: {
  cycleId: string;
  sessions: CalibrationSession[];
  onCreate: (input: { cycle_id: string; name: string; scheduled_at?: string | null; location?: string | null; notes?: string | null }) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", scheduled_at: "", location: "", notes: "" });

  async function submit() {
    await onCreate({
      cycle_id: cycleId,
      name: form.name,
      scheduled_at: form.scheduled_at || null,
      location: form.location || null,
      notes: form.notes || null,
    });
    setForm({ name: "", scheduled_at: "", location: "", notes: "" });
    setOpen(false);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Calibration sessions</CardTitle>
          <CardDescription>Schedule group calibration meetings for this cycle.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <CalendarPlus className="h-3 w-3 mr-1" /> Schedule
        </Button>
        <TalentFormShell
          open={open}
          onOpenChange={setOpen}
          entity="calibration-session"
          submitLabel="Schedule"
          submitDisabled={!form.name.trim()}
          onSubmit={submit}
        >
          <WorkflowSheetSection number={1} title="Session details" subtitle="What is this session called, and when does it happen?">
            <WorkflowSheetGrid>
              <WorkflowField label="Name" required>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Q3 Engineering calibration" />
              </WorkflowField>
              <WorkflowField label="Scheduled at">
                <Input type="datetime-local" value={form.scheduled_at} onChange={(e) => setForm((f) => ({ ...f, scheduled_at: e.target.value }))} />
              </WorkflowField>
              <WorkflowField label="Location" className="lg:col-span-2">
                <Input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} placeholder="Room 4 / Zoom" />
              </WorkflowField>
            </WorkflowSheetGrid>
          </WorkflowSheetSection>
          <WorkflowSheetSection number={2} title="Notes" subtitle="Agenda, expected attendees, or anything panelists should prep.">
            <Textarea rows={4} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </WorkflowSheetSection>
        </TalentFormShell>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sessions scheduled yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between rounded border px-3 py-2">
                <div>
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.scheduled_at ? new Date(s.scheduled_at).toLocaleString() : "Unscheduled"}
                    {s.location ? ` · ${s.location}` : ""}
                  </div>
                </div>
                <Badge variant="outline">{s.status.replace(/_/g, " ")}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ProposeDialog({
  reviewId, cycleId, employeeId, originalRating, sessions, onPropose,
}: {
  reviewId: string;
  cycleId: string;
  employeeId: string;
  originalRating: number | null;
  sessions: CalibrationSession[];
  onPropose: (input: {
    session_id: string | null;
    cycle_id: string;
    review_id: string;
    employee_id: string;
    original_rating: number | null;
    proposed_rating: number;
    rationale: string;
  }) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [proposedRating, setProposedRating] = useState<string>((originalRating ?? "").toString());
  const [rationale, setRationale] = useState("");
  const [sessionId, setSessionId] = useState<string>(sessions[0]?.id ?? "");

  async function submit() {
    if (!proposedRating || !rationale.trim()) return;
    await onPropose({
      session_id: sessionId || null,
      cycle_id: cycleId,
      review_id: reviewId,
      employee_id: employeeId,
      original_rating: originalRating,
      proposed_rating: Number(proposedRating),
      rationale: rationale.trim(),
    });
    setOpen(false);
    setRationale("");
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <UserPlus2 className="h-3 w-3 mr-1" /> Propose
      </Button>
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="calibration-adjustment"
        submitLabel="Propose"
        submitDisabled={!proposedRating || !rationale.trim()}
        onSubmit={submit}
      >
        <WorkflowSheetSection number={1} title="Adjustment" subtitle={<>Current rating: <strong>{originalRating ?? "—"}</strong></>}>
          <WorkflowSheetGrid>
            <WorkflowField label="Proposed rating (1–5)" required>
              <Input type="number" min={1} max={5} step={0.5} value={proposedRating} onChange={(e) => setProposedRating(e.target.value)} />
            </WorkflowField>
            {sessions.length > 0 ? (
              <WorkflowField label="Session" hint="Optional. Group adjustments under a scheduled session.">
                <select className="w-full h-9 rounded-md border bg-background px-2 text-sm" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                  <option value="">(none)</option>
                  {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </WorkflowField>
            ) : null}
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Rationale" subtitle="Required. Audit trail for why this rating should change.">
          <Textarea rows={5} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Why this rating should change…" />
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}
