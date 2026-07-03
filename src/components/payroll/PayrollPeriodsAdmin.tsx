/**
 * PayrollPeriodsAdmin — governed operational workspace for payroll periods.
 *
 * Every row is an operational card, not a status toggle:
 *   - lifecycle chip driven by `getPeriodLifecycle` (never `status === "open"`)
 *   - inline readiness (blockers + counts) via `payroll_period_readiness`
 *   - audit timeline from `payroll_period_audit`
 *   - close/reopen go through `payroll_period_close_atomic` /
 *     `payroll_period_reopen_atomic` — the DB sentinel refuses direct
 *     status writes, so no other path is possible.
 */
import { useState } from "react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { usePayrollPeriods, type PayrollPeriod } from "@/hooks/usePayrollPeriods";
import { usePayrollPeriodDetail } from "@/hooks/usePayrollPeriodDetail";
import {
  canClosePeriod,
  canReopenPeriod,
  getPeriodLifecycle,
  periodStatusBadgeVariant,
} from "@/lib/payroll/periodLifecycle";
import { AlertTriangle, ChevronDown, ChevronRight, Lock, Unlock } from "lucide-react";

const BLOCKER_LABELS: Record<string, string> = {
  pending_timesheets: "Unapproved timesheets",
  pending_leave: "Pending leave requests",
  pending_attendance_corrections: "Pending attendance corrections",
  draft_or_failed_runs: "Draft or failed payroll runs",
  unposted_journals: "Unposted payroll journals",
  unpaid_remittances: "Unpaid statutory remittances",
  open_return_runs: "Open statutory return runs",
};

export function PayrollPeriodsAdmin() {
  const { periods, isLoading, closePeriod, reopenPeriod } = usePayrollPeriods();
  const [reopenTarget, setReopenTarget] = useState<PayrollPeriod | null>(null);
  const [closeTarget, setCloseTarget] = useState<PayrollPeriod | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [force, setForce] = useState(false);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground p-4">Loading periods…</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Payroll periods</CardTitle>
        <p className="text-sm text-muted-foreground">
          Expand a period to review readiness blockers and its transition history.
          Close and reopen are governed by atomic RPCs — direct status edits are
          rejected by the database.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {periods.length === 0 && (
          <p className="text-sm text-muted-foreground">No periods generated yet.</p>
        )}
        {periods.map((p) => {
          const lifecycle = getPeriodLifecycle(p);
          const isExpanded = expandedId === p.id;
          return (
            <div key={p.id} className="rounded-md border">
              <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                <button
                  type="button"
                  className="flex items-center gap-2 text-left"
                  onClick={() => setExpandedId(isExpanded ? null : p.id)}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{p.name}</p>
                      <Badge variant={periodStatusBadgeVariant(lifecycle)}>
                        {lifecycle}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(p.start_date), "MMM d, yyyy")} –{" "}
                      {format(new Date(p.end_date), "MMM d, yyyy")}
                    </p>
                  </div>
                </button>
                <div className="flex items-center gap-2">
                  {canClosePeriod(p) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={closePeriod.isPending}
                      onClick={() => {
                        setCloseTarget(p);
                        setReason("");
                        setOverrideReason("");
                        setForce(false);
                      }}
                    >
                      <Lock className="h-4 w-4 mr-1" /> Close
                    </Button>
                  )}
                  {canReopenPeriod(p) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setReopenTarget(p);
                        setReason("");
                      }}
                    >
                      <Unlock className="h-4 w-4 mr-1" /> Reopen
                    </Button>
                  )}
                </div>
              </div>
              {isExpanded && <PeriodDetailPanel period={p} />}
            </div>
          );
        })}
      </CardContent>

      {/* --- Close dialog --- */}
      <AlertDialog open={!!closeTarget} onOpenChange={(o) => !o && setCloseTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close payroll period</AlertDialogTitle>
            <AlertDialogDescription>
              The server runs readiness checks and cascades the timesheet lock.
              If blockers exist, tick “force close” and provide an override reason
              (audited).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="close-reason">Reason (optional)</Label>
              <Input
                id="close-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              Force close over blockers
            </label>
            {force && (
              <div>
                <Label htmlFor="override-reason">Override reason (required)</Label>
                <Textarea
                  id="override-reason"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
              </div>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                closePeriod.isPending ||
                (force && overrideReason.trim().length === 0)
              }
              onClick={() => {
                if (!closeTarget) return;
                closePeriod.mutate({
                  periodId: closeTarget.id,
                  reason: reason || undefined,
                  force,
                  overrideReason: force ? overrideReason : undefined,
                });
                setCloseTarget(null);
              }}
            >
              Close period
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* --- Reopen dialog --- */}
      <AlertDialog open={!!reopenTarget} onOpenChange={(o) => !o && setReopenTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reopen payroll period</AlertDialogTitle>
            <AlertDialogDescription>
              This unlocks every timesheet in the window. Provide a reason for the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reopen-reason">Reason</Label>
            <Input id="reopen-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!reason.trim() || reopenPeriod.isPending}
              onClick={() => {
                if (!reopenTarget) return;
                reopenPeriod.mutate({ periodId: reopenTarget.id, reason });
                setReopenTarget(null);
              }}
            >
              Reopen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function PeriodDetailPanel({ period }: { period: PayrollPeriod }) {
  const { readiness, audit } = usePayrollPeriodDetail(period.id);

  return (
    <div className="border-t bg-muted/30 p-4 space-y-4">
      <section>
        <h4 className="text-sm font-semibold mb-2">Readiness</h4>
        {readiness.isLoading && (
          <p className="text-xs text-muted-foreground">Checking…</p>
        )}
        {readiness.data && readiness.data.ready && (
          <Alert>
            <AlertTitle>Ready to close</AlertTitle>
            <AlertDescription className="text-xs">
              Checked {format(new Date(readiness.data.checked_at), "PPpp")}
            </AlertDescription>
          </Alert>
        )}
        {readiness.data && !readiness.data.ready && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Blockers ({readiness.data.blockers.length})</AlertTitle>
            <AlertDescription>
              <ul className="mt-2 space-y-1 text-xs">
                {readiness.data.blockers.map((b) => (
                  <li key={b.code} className="flex justify-between">
                    <span>{BLOCKER_LABELS[b.code] ?? b.code}</span>
                    <span className="font-mono">{b.count}</span>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </section>

      <Separator />

      <section>
        <h4 className="text-sm font-semibold mb-2">Transition history</h4>
        {audit.isLoading && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
        {audit.data && audit.data.length === 0 && (
          <p className="text-xs text-muted-foreground">No transitions yet.</p>
        )}
        {audit.data && audit.data.length > 0 && (
          <ol className="space-y-2">
            {audit.data.map((row) => (
              <li
                key={row.id}
                className="rounded border bg-background p-2 text-xs space-y-1"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{row.from_status ?? "—"}</Badge>
                  <span>→</span>
                  <Badge>{row.to_status}</Badge>
                  <span className="ml-auto text-muted-foreground">
                    {format(new Date(row.created_at), "PPpp")}
                  </span>
                </div>
                {row.reason && <p className="text-muted-foreground">{row.reason}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
