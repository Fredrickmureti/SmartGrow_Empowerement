/**
 * PayrollPeriodsAdmin — admin UI for opening/closing payroll periods.
 *
 * Closing a period calls `lock_timesheets_for_payroll(periodId)` on the
 * server which flips approved timesheets in the window to
 * `payroll_locked=true` (audited). Reopening unlocks them. The hook handles
 * both round-trips.
 *
 * No hardcoded period list — periods come from `usePayrollPeriods`.
 */
import { useState } from "react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { usePayrollPeriods, type PayrollPeriod } from "@/hooks/usePayrollPeriods";
import { Lock, Unlock } from "lucide-react";

export function PayrollPeriodsAdmin() {
  const { periods, isLoading, closePeriod, reopenPeriod } = usePayrollPeriods();
  const [reopenTarget, setReopenTarget] = useState<PayrollPeriod | null>(null);
  const [reason, setReason] = useState("");

  if (isLoading) {
    return <p className="text-sm text-muted-foreground p-4">Loading periods…</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Periods</CardTitle>
        <p className="text-sm text-muted-foreground">
          Closing a period locks all approved timesheets that fall in its window
          so they cannot be edited or re-billed.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {periods.length === 0 && (
          <p className="text-sm text-muted-foreground">No periods generated yet.</p>
        )}
        {periods.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <p className="font-medium">{p.name}</p>
                <Badge variant={p.status === "open" ? "outline" : "secondary"}>
                  {p.status}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {format(new Date(p.start_date), "MMM d, yyyy")} – {format(new Date(p.end_date), "MMM d, yyyy")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {["open","preparing","processing","awaiting_approval","reopened"].includes(p.status) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={closePeriod.isPending}
                  onClick={() => closePeriod.mutate({ periodId: p.id })}
                >
                  <Lock className="h-4 w-4 mr-1" /> Close & lock timesheets
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setReopenTarget(p); setReason(""); }}
                >
                  <Unlock className="h-4 w-4 mr-1" /> Reopen
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>

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
