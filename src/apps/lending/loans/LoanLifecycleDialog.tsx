/**
 * Loan lifecycle exceptions (C8) — write-off and closure.
 *
 * Both are guarded server-side business events: the write-off derives the
 * amounts from the loan's own outstanding balances and posts the configured
 * accounting treatment; closure is refused while anything remains due. React
 * only collects intent and a reason.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { MfLoan } from "@/hooks/useMfLoans";

export type LoanLifecycleAction = "write_off" | "close";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loan: MfLoan | null;
  action: LoanLifecycleAction;
  onWriteOff: (input: { loanId: string; writtenOffOn: string; reason: string }) => Promise<void>;
  onClose: (input: { loanId: string; closedOn: string; notes: string | null }) => Promise<void>;
}

export function LoanLifecycleDialog({
  open,
  onOpenChange,
  loan,
  action,
  onWriteOff,
  onClose,
}: Props) {
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDate(new Date().toISOString().slice(0, 10));
    setReason("");
  }, [open, loan, action]);

  const isWriteOff = action === "write_off";
  const canSubmit = !!loan && !!date && (!isWriteOff || reason.trim().length > 0);

  const submit = async () => {
    if (!loan || !canSubmit) return;
    setSaving(true);
    try {
      if (isWriteOff) {
        await onWriteOff({ loanId: loan.id, writtenOffOn: date, reason: reason.trim() });
      } else {
        await onClose({ loanId: loan.id, closedOn: date, notes: reason.trim() || null });
      }
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isWriteOff ? "Write off loan" : "Close loan"} {loan?.loan_number ?? ""}
          </DialogTitle>
          <DialogDescription>
            {isWriteOff
              ? "The outstanding principal and interest are taken from the loan's own balances and posted to the configured write-off accounts. This cannot be undone."
              : "Closure is only accepted once the loan is fully settled. The loan and its history remain on record."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="lifecycle-date">{isWriteOff ? "Write-off date" : "Closure date"}</Label>
            <Input
              id="lifecycle-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lifecycle-reason">
              {isWriteOff ? "Reason (required)" : "Notes (optional)"}
            </Label>
            <Textarea
              id="lifecycle-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                isWriteOff
                  ? "Why is this loan being written off?"
                  : "Anything worth recording about this closure"
              }
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant={isWriteOff ? "destructive" : "default"}
            onClick={submit}
            disabled={!canSubmit || saving}
          >
            {saving ? "Working…" : isWriteOff ? "Write off loan" : "Close loan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default LoanLifecycleDialog;
