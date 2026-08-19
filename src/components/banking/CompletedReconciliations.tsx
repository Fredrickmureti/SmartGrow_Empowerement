import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CheckCircle2, Loader2, LockKeyholeOpen } from "lucide-react";
import { formatDate, cn } from "@/lib/utils";
import { useCurrency } from "@/hooks/useCurrency";
import type { ReconciliationSession } from "@/hooks/useReconciliationSessions";

interface CompletedReconciliationsProps {
  sessions: ReconciliationSession[];
  canReconcile: boolean;
  isSaving: boolean;
  onReopen: (sessionId: string, reason: string) => Promise<boolean>;
}

/**
 * F17 — a completed reconciliation is a fact: its window is shut, so matches
 * on lines inside it cannot be confirmed, reversed or unreconciled. Undoing
 * that closure is therefore a deliberate, audited act: the server demands a
 * reason, refuses out of statement order and refuses in a locked period. This
 * panel is the only place an operator performs it.
 */
export function CompletedReconciliations({
  sessions,
  canReconcile,
  isSaving,
  onReopen,
}: CompletedReconciliationsProps) {
  const { formatCurrency } = useCurrency();
  const [target, setTarget] = useState<ReconciliationSession | null>(null);
  const [reason, setReason] = useState("");

  const completed = useMemo(
    () =>
      sessions
        .filter(s => s.status === "completed")
        .sort((a, b) => (a.statement_date < b.statement_date ? 1 : -1))
        .slice(0, 12),
    [sessions],
  );

  if (completed.length === 0) return null;

  const submit = async () => {
    if (!target || reason.trim().length === 0) return;
    const ok = await onReopen(target.id, reason.trim());
    if (ok) {
      setTarget(null);
      setReason("");
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            Completed reconciliations
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="divide-y">
            {completed.map(s => {
              const diff = Number(s.difference ?? 0);
              return (
                <div key={s.id} className="flex flex-wrap items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{formatDate(s.statement_date)}</p>
                    <p className="text-xs text-muted-foreground">
                      Statement {formatCurrency(s.closing_balance)} · Cleared{" "}
                      {formatCurrency(s.reconciled_balance)}
                      {s.completed_at ? ` · closed ${formatDate(s.completed_at)}` : ""}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      "tabular-nums",
                      Math.abs(diff) < 0.01
                        ? "text-green-600 border-green-600/30"
                        : "text-destructive border-destructive/30",
                    )}
                  >
                    Difference {formatCurrency(diff)}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canReconcile || isSaving}
                    title={
                      !canReconcile
                        ? "You don't have permission to reconcile bank transactions in this scope."
                        : "Reopening is recorded with your reason"
                    }
                    onClick={() => {
                      setTarget(s);
                      setReason("");
                    }}
                  >
                    <LockKeyholeOpen className="mr-2 h-4 w-4" />
                    Reopen
                  </Button>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!target} onOpenChange={open => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen reconciliation</DialogTitle>
            <DialogDescription>
              {target ? `Statement dated ${formatDate(target.statement_date)}. ` : ""}
              While a reconciliation is closed, the lines inside it cannot be rematched or
              unreconciled. Reopening is recorded against your name with the reason you give, and
              is refused when a later reconciliation is already closed or the period is locked.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reopen-reason">Reason</Label>
            <Textarea
              id="reopen-reason"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. the bank restated two cleared deposits"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              Keep it closed
            </Button>
            <Button onClick={submit} disabled={reason.trim().length === 0 || isSaving}>
              {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Reopen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
