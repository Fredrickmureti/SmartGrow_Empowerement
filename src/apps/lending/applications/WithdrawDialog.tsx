/**
 * Withdraw an application that is no longer proceeding.
 *
 * Withdrawal keeps the record — it is a lifecycle move, not a removal — so a
 * reason is mandatory. The database (`mf_withdraw_loan_application`) owns every
 * rule; this dialog only collects the reason and shows the refusal.
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { MfLoanApplication } from "@/hooks/useMfApplications";

export function WithdrawDialog({
  open,
  onOpenChange,
  application,
  onWithdraw,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: MfLoanApplication | null;
  onWithdraw: (input: { id: string; reason: string }) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const submit = async () => {
    if (!application || !reason.trim()) return;
    setBusy(true);
    try {
      await onWithdraw({ id: application.id, reason: reason.trim() });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Withdraw application</DialogTitle>
          <DialogDescription>
            {application
              ? `${application.application_number} stays on record as withdrawn — it is not removed.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="withdraw-reason">Reason</Label>
          <Textarea
            id="withdraw-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this application no longer proceeding?"
            rows={3}
          />
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !reason.trim()}>
            {busy ? "Withdrawing…" : "Withdraw"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default WithdrawDialog;
