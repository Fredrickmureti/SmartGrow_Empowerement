/**
 * PayrollJobPanel — authoritative live view of payroll execution.
 *
 * This component replaces the old "await invoke() and show a toast" model.
 * It renders the current state of every non-terminal payroll job for the
 * org and refreshes automatically via realtime — so a user who reloads
 * the tab mid-run, or opens a second tab, sees the exact same truth as
 * the server.
 */
import { AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react";
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
import { useState } from "react";

function phaseLabel(job: PayrollJobRow): string {
  if (job.status === "queued") return "Queued — waiting for worker";
  if (job.status === "running") {
    if (job.cancel_requested_at) return "Cancelling…";
    const p = job.phase ?? "running";
    return `Running · ${p}`;
  }
  if (job.status === "succeeded") return "Completed";
  if (job.status === "failed") return job.error_code === "CANCELLED" ? "Cancelled" : "Failed";
  return String(job.status);
}

function statusVariant(job: PayrollJobRow) {
  if (job.status === "succeeded") return "default" as const;
  if (job.status === "failed") return "destructive" as const;
  return "secondary" as const;
}

function StatusIcon({ job }: { job: PayrollJobRow }) {
  if (job.status === "succeeded") return <CheckCircle2 className="h-4 w-4 text-green-600" />;
  if (job.status === "failed") return <XCircle className="h-4 w-4 text-destructive" />;
  if (job.status === "queued" || job.status === "running") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
}

function JobCard({ job }: { job: PayrollJobRow }) {
  const [cancelling, setCancelling] = useState(false);
  const isActive = job.status === "queued" || job.status === "running";
  const pct =
    job.progress_total > 0
      ? Math.min(100, Math.round((job.progress_current / job.progress_total) * 100))
      : job.status === "succeeded"
      ? 100
      : 0;

  const heartbeatAge = job.heartbeat_at
    ? formatDistanceToNow(new Date(job.heartbeat_at), { addSuffix: true })
    : "—";

  const startedAge = job.accepted_at ?? job.created_at;

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

  return (
    <Card className="border-l-4" style={{ borderLeftColor: job.status === "failed" ? "hsl(var(--destructive))" : job.status === "succeeded" ? "hsl(142 71% 45%)" : "hsl(var(--primary))" }}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <StatusIcon job={job} />
            <div>
              <div className="font-medium text-sm">
                Payroll · {job.pay_period_start} → {job.pay_period_end}
                <span className="ml-2 text-xs text-muted-foreground">
                  ({job.run_type}{job.attempt > 1 ? ` · attempt ${job.attempt}` : ""})
                </span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {phaseLabel(job)}
                {isActive && (
                  <>
                    {" · "}
                    <span title={job.heartbeat_at ?? undefined}>last heartbeat {heartbeatAge}</span>
                  </>
                )}
                {startedAge && (
                  <>
                    {" · "}
                    started {formatDistanceToNow(new Date(startedAge), { addSuffix: true })}
                  </>
                )}
              </div>
            </div>
          </div>
          <Badge variant={statusVariant(job)}>{job.status}</Badge>
        </div>

        {(isActive || job.status === "succeeded") && (
          <div className="space-y-1">
            <Progress value={pct} className="h-1.5" />
            <div className="text-xs text-muted-foreground text-right">
              {job.progress_current} / {job.progress_total || job.employee_count} employees
            </div>
          </div>
        )}

        {job.status === "failed" && job.error_message && (
          <div className="text-xs text-destructive bg-destructive/10 rounded p-2">
            {job.error_code === "WORKER_STALE" ? (
              <>
                The payroll worker stopped responding. No further employees will be processed.
                Reopen the runs list and re-run when ready — the server prevents duplicate payslips.
              </>
            ) : (
              <>
                {job.error_code && <strong className="font-semibold">{job.error_code}: </strong>}
                {job.error_message}
              </>
            )}
          </div>
        )}

        {isActive && !job.cancel_requested_at && (
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={cancelling}>
              {cancelling ? "Requesting…" : "Cancel"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function PayrollJobPanel() {
  const { active, recentTerminal, loading } = useActivePayrollJobs(10);

  if (loading) return null;
  if (active.length === 0 && recentTerminal.length === 0) return null;

  return (
    <div className="space-y-2">
      {active.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
      {recentTerminal.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
    </div>
  );
}