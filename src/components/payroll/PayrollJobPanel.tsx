/**
 * PayrollJobPanel — enterprise-grade live view of payroll execution.
 *
 * Reads authoritative state from `payroll_run_jobs` (populated by the
 * compute-payroll worker) and renders a phase stepper, live progress,
 * elapsed timer, and an opt-in completion chime.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Volume2,
  VolumeX,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  requestCancelPayrollJob,
  useActivePayrollJobs,
  type PayrollJobRow,
} from "@/hooks/payroll/usePayrollJob";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ─── Phase stepper contract ──────────────────────────────────────────────
type PhaseKey = "preparing" | "computing" | "posting" | "completed";
const PHASE_ORDER: PhaseKey[] = ["preparing", "computing", "posting", "completed"];
const PHASE_LABEL: Record<PhaseKey, string> = {
  preparing: "Preparing",
  computing: "Computing",
  posting: "Posting",
  completed: "Completed",
};

function normalizePhase(job: PayrollJobRow): PhaseKey {
  if (job.status === "succeeded") return "completed";
  if (job.status === "queued") return "preparing";
  const raw = (job.phase ?? "").toLowerCase();
  if (raw.includes("post") || raw.includes("journal") || raw.includes("gl")) return "posting";
  if (raw.includes("comput") || raw.includes("running") || raw.includes("employee")) return "computing";
  if (raw.includes("complete") || raw.includes("finish")) return "completed";
  return job.status === "running" ? "computing" : "preparing";
}

function statusBadgeVariant(job: PayrollJobRow) {
  if (job.status === "succeeded") return "default" as const;
  if (job.status === "failed") return "destructive" as const;
  return "secondary" as const;
}

function statusLabel(job: PayrollJobRow) {
  if (job.status === "failed" && job.error_code === "CANCELLED") return "cancelled";
  return job.status;
}

// ─── Sound: opt-in, one chime per observed transition to terminal ────────
const SOUND_PREF_KEY = "payroll.jobPanel.sound";
function readSoundPref(): boolean {
  if (typeof window === "undefined") return true;
  const v = window.localStorage.getItem(SOUND_PREF_KEY);
  return v !== "off";
}
function writeSoundPref(on: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SOUND_PREF_KEY, on ? "on" : "off");
}

const successAudioSrc = (successAsset as { url: string }).url;
const failureAudioSrc = (failureAsset as { url: string }).url;

// ─── Web Audio synthesis ────────────────────────────────────────────────
// We synthesize the chime with Web Audio API instead of streaming a wav.
// This removes the dependency on a hosted asset (which 404s in preview),
// works offline, and is robust to autoplay policies once the user has
// interacted with the page (e.g. toggled the sound button).
let _audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!_audioCtx) {
    try {
      _audioCtx = new Ctor();
    } catch {
      return null;
    }
  }
  if (_audioCtx.state === "suspended") {
    // Best-effort resume — will succeed if a prior user gesture unlocked audio.
    _audioCtx.resume().catch(() => {});
  }
  return _audioCtx;
}

// Unlock the audio context on the first user gesture so later programmatic
// chimes (fired from a realtime callback, not a click) are allowed to play.
if (typeof window !== "undefined") {
  const unlock = () => {
    getAudioCtx();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

function playTone(
  ctx: AudioContext,
  freq: number,
  startAt: number,
  durationMs: number,
  gain = 0.18,
) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, startAt);
  // Short attack + exponential release for a pleasant chime, avoids clicks.
  g.gain.setValueAtTime(0.0001, startAt);
  g.gain.exponentialRampToValueAtTime(gain, startAt + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + durationMs / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + durationMs / 1000 + 0.02);
}

function playChime(kind: "success" | "failure") {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.01;
  try {
    if (kind === "success") {
      // Rising two-note: C5 → E5 → G5 (major triad arpeggio).
      playTone(ctx, 523.25, t0, 160);
      playTone(ctx, 659.25, t0 + 0.14, 160);
      playTone(ctx, 783.99, t0 + 0.28, 260);
    } else {
      // Descending two-note failure cue: A4 → E4.
      playTone(ctx, 440.0, t0, 200, 0.2);
      playTone(ctx, 329.63, t0 + 0.18, 340, 0.2);
    }
  } catch {
    // Silently ignore — visual state remains authoritative.
  }
}

// ─── Elapsed timer (ticks while active, frozen when terminal) ────────────
function useElapsed(startIso: string | null, endIso: string | null, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : now;
  const ms = Math.max(0, end - start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ─── Phase stepper ───────────────────────────────────────────────────────
function PhaseStepper({ job }: { job: PayrollJobRow }) {
  const current = normalizePhase(job);
  const failed = job.status === "failed";
  const currentIdx = PHASE_ORDER.indexOf(current);
  return (
    <ol className="flex items-center gap-1.5 text-[11px] font-medium" aria-label="Payroll phase">
      {PHASE_ORDER.map((p, idx) => {
        const isDone = !failed && idx < currentIdx;
        const isCurrent = !failed && idx === currentIdx && job.status !== "succeeded";
        const isSucceededTerm = !failed && job.status === "succeeded";
        const isFailedHere = failed && idx === Math.max(0, currentIdx);
        return (
          <li key={p} className="flex items-center gap-1.5">
            <span
              aria-label={`${PHASE_LABEL[p]} ${isDone || isSucceededTerm ? "complete" : isCurrent ? "in progress" : "pending"}`}
              className={cn(
                "inline-block h-2 w-2 rounded-full transition-colors",
                (isDone || isSucceededTerm) && "bg-[hsl(var(--success))]",
                isCurrent && "bg-primary animate-pulse ring-2 ring-primary/25",
                isFailedHere && "bg-destructive",
                !isDone && !isCurrent && !isSucceededTerm && !isFailedHere && "bg-muted-foreground/25",
              )}
            />
            <span
              className={cn(
                "select-none",
                (isDone || isSucceededTerm) && "text-foreground",
                isCurrent && "text-primary",
                isFailedHere && "text-destructive",
                !isDone && !isCurrent && !isSucceededTerm && !isFailedHere && "text-muted-foreground/70",
              )}
            >
              {PHASE_LABEL[p]}
            </span>
            {idx < PHASE_ORDER.length - 1 && (
              <span className="mx-1 h-px w-4 bg-border" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ─── Individual job card ─────────────────────────────────────────────────
function JobCard({ job }: { job: PayrollJobRow }) {
  const [cancelling, setCancelling] = useState(false);
  const isActive = job.status === "queued" || job.status === "running";
  const isTerminalSuccess = job.status === "succeeded";
  const isTerminalFail = job.status === "failed";

  // Progress: on success always 100 with X/X counter — even if the worker
  // finalized before the last per-employee heartbeat.
  const total = job.progress_total || job.employee_count || 0;
  const current = isTerminalSuccess ? total : Math.min(job.progress_current, total || job.progress_current);
  const pct = isTerminalSuccess
    ? 100
    : total > 0
    ? Math.min(100, Math.round((current / total) * 100))
    : 0;

  const startedAge = job.started_at ?? job.accepted_at ?? job.created_at;
  const elapsed = useElapsed(startedAge, job.finished_at, isActive);
  const finishedRel = job.finished_at
    ? formatDistanceToNow(new Date(job.finished_at), { addSuffix: true })
    : null;

  const onCancel = async () => {
    if (!confirm("Ask the payroll engine to stop after the current employee?")) return;
    setCancelling(true);
    try {
      await requestCancelPayrollJob(job.id);
      toast.info("Cancellation requested. The engine will stop after the current employee.");
    } catch (e: any) {
      toast.error("Could not request cancellation", { description: String(e?.message ?? e) });
    } finally {
      setCancelling(false);
    }
  };

  const borderTone = isTerminalFail
    ? "hsl(var(--destructive))"
    : isTerminalSuccess
    ? "hsl(var(--success))"
    : "hsl(var(--primary))";

  return (
    <Card
      role="status"
      aria-live="polite"
      className="border-l-4 shadow-sm"
      style={{ borderLeftColor: borderTone }}
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            {isTerminalSuccess ? (
              <CheckCircle2 className="h-4 w-4 mt-0.5 text-[hsl(var(--success))]" />
            ) : isTerminalFail ? (
              <XCircle className="h-4 w-4 mt-0.5 text-destructive" />
            ) : (
              <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-primary" />
            )}
            <div className="min-w-0">
              <div className="font-medium text-sm">
                Payroll · {job.pay_period_start} → {job.pay_period_end}
                <span className="ml-2 text-xs text-muted-foreground">
                  ({job.run_type}
                  {job.attempt > 1 ? ` · attempt ${job.attempt}` : ""})
                </span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {isActive && elapsed && <span>Running for {elapsed}</span>}
                {isTerminalSuccess && finishedRel && (
                  <span>
                    Finished {finishedRel}
                    {elapsed && ` · took ${elapsed}`}
                  </span>
                )}
                {isTerminalFail && finishedRel && (
                  <span>
                    {job.error_code === "CANCELLED" ? "Cancelled" : "Failed"} {finishedRel}
                  </span>
                )}
              </div>
            </div>
          </div>
          <Badge variant={statusBadgeVariant(job)} className="capitalize">
            {statusLabel(job)}
          </Badge>
        </div>

        <PhaseStepper job={job} />

        <div className="space-y-1">
          <Progress
            value={pct}
            className="h-2"
            aria-label="Payroll progress"
            aria-valuenow={pct}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {current} of {total || "—"} employees{isTerminalSuccess ? " processed" : ""}
            </span>
            <span className="tabular-nums">{pct}%</span>
          </div>
        </div>

        {isTerminalFail && job.error_message && (
          <div className="flex gap-2 text-xs text-destructive bg-destructive/10 rounded p-2">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <div>
              {job.error_code === "WORKER_STALE" ? (
                <>
                  The payroll worker stopped responding. No further employees will be
                  processed. Reopen the runs list and re-run when ready — the server
                  prevents duplicate payslips.
                </>
              ) : (
                <>
                  {job.error_code && (
                    <strong className="font-semibold">{job.error_code}: </strong>
                  )}
                  {job.error_message}
                </>
              )}
            </div>
          </div>
        )}

        {isActive && !job.cancel_requested_at && (
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={cancelling}>
              {cancelling ? "Requesting…" : "Cancel run"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Panel root: subscribes + drives sound on transitions ────────────────
export function PayrollJobPanel() {
  const { active, recentTerminal, loading } = useActivePayrollJobs(15);
  const [soundOn, setSoundOn] = useState<boolean>(() => readSoundPref());

  // Track prior status per job id so we only chime on the *transition* to
  // a terminal state — never on initial mount or realtime replays.
  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const initialMountRef = useRef(true);

  useEffect(() => {
    const all = [...active, ...recentTerminal];
    const prev = prevStatusRef.current;
    if (initialMountRef.current) {
      // Seed without firing sound so freshly-opened tabs don't chime for
      // jobs that finished before we mounted.
      for (const j of all) prev.set(j.id, j.status);
      initialMountRef.current = false;
      return;
    }
    for (const j of all) {
      const before = prev.get(j.id);
      const after = j.status;
      if (before && before !== after) {
        if (soundOn && after === "succeeded") playChime("success");
        else if (soundOn && after === "failed") playChime("failure");
      }
      prev.set(j.id, after);
    }
  }, [active, recentTerminal, soundOn]);

  if (loading) return null;
  if (active.length === 0 && recentTerminal.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Payroll runs
          {active.length > 0 && (
            <span className="ml-2 normal-case tracking-normal text-foreground">
              {active.length} in progress
            </span>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          aria-pressed={soundOn}
          aria-label={soundOn ? "Mute completion chime" : "Enable completion chime"}
          onClick={() => {
            const next = !soundOn;
            setSoundOn(next);
            writeSoundPref(next);
          }}
        >
          {soundOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
          <span className="ml-1.5">{soundOn ? "Sound on" : "Sound off"}</span>
        </Button>
      </div>
      {active.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
      {recentTerminal.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
    </div>
  );
}
