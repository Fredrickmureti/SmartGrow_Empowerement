import { useState } from "react";
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
import { Loader2 } from "lucide-react";

interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  /** Reason is mandatory server-side, so the dialog enforces it client-side too. */
  onConfirm: (reason: string) => Promise<void>;
  destructive?: boolean;
}

/**
 * Reason capture for governed CRM lifecycle transitions (withdraw proposition,
 * archive, restore, reopen). The database refuses these operations without a
 * reason, so the UI must always collect one rather than inventing a default.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive,
}: ReasonDialogProps) {
  const [reason, setReason] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const close = (next: boolean) => {
    if (isBusy) return;
    if (!next) setReason("");
    onOpenChange(next);
  };

  const submit = async () => {
    if (!reason.trim()) return;
    setIsBusy(true);
    try {
      await onConfirm(reason.trim());
      setReason("");
      onOpenChange(false);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="crm-reason">Reason</Label>
          <Textarea
            id="crm-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Recorded on the opportunity's audit trail"
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={isBusy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={submit}
            disabled={isBusy || !reason.trim()}
          >
            {isBusy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
