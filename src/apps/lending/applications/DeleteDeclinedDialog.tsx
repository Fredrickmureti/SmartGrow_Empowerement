/**
 * Permanently remove a declined application.
 *
 * A declined application is a record the institution kept on purpose, so
 * removal is deliberate: administrator only, a written reason, and the
 * application number typed back. The database
 * (`mf_delete_loan_application`) owns every rule; this dialog only collects
 * the confirmation.
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
import type { MfLoanApplication } from "@/hooks/useMfApplications";

export function DeleteDeclinedDialog({
  open,
  onOpenChange,
  application,
  clientLabel,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: MfLoanApplication | null;
  clientLabel: string;
  onDelete: (input: { id: string; reason: string }) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setReason("");
      setTyped("");
    }
  }, [open]);

  const numberMatches =
    !!application && typed.trim().toUpperCase() === application.application_number.toUpperCase();
  const ready = numberMatches && reason.trim().length > 0;

  const submit = async () => {
    if (!application || !ready) return;
    setBusy(true);
    try {
      await onDelete({ id: application.id, reason: reason.trim() });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete declined application</DialogTitle>
          <DialogDescription>
            {application
              ? `${application.application_number} for ${clientLabel} was declined and is kept as a record. Deleting it removes that record permanently. It produced no loan, so nothing is lost from the ledger.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="declined-delete-reason">Reason for deleting</Label>
            <Textarea
              id="declined-delete-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why should this declined application be removed?"
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="declined-delete-confirm">
              Type {application?.application_number ?? ""} to confirm
            </Label>
            <Input
              id="declined-delete-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={application?.application_number ?? ""}
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={busy || !ready}>
            {busy ? "Deleting…" : "Delete permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default DeleteDeclinedDialog;
