/**
 * Reject Loan Dialog — captures a required rejection reason before
 * transitioning a loan request to status='rejected'.
 *
 * Migrated to the enterprise WorkflowSheet primitive (Pass 1.5 — Payroll
 * closure) so reason-capture surfaces share the same right-side sheet,
 * sticky footer and section framing used across HR & Payroll workflows.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

interface Props {
  open: boolean;
  loanNumber: string | null;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

export function RejectLoanDialog({ open, loanNumber, onClose, onConfirm }: Props) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (!reason.trim()) {
      toast.error("Please provide a reason for rejection");
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm(reason.trim());
      setReason("");
      onClose();
    } catch (err: any) {
      toast.error(err.message || "Failed to reject loan");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={(o) => !o && !submitting && onClose()}
      size="md"
      title="Reject loan request"
      description={
        loanNumber
          ? `Provide a reason for rejecting ${loanNumber}. The employee will see this reason.`
          : "Provide a reason. The employee will see this reason."
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={submitting}>
            {submitting ? "Rejecting…" : "Reject request"}
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Reason">
        <WorkflowField label="Reason for rejection" htmlFor="reject-reason" required>
          <Textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Exceeds eligible limit, insufficient tenure, etc."
            rows={5}
          />
        </WorkflowField>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
