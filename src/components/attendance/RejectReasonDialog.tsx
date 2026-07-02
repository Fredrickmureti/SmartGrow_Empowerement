/**
 * RejectReasonDialog — shared reason-capture dialog for attendance
 * rejection flows (single-row + bulk, corrections + overtime).
 *
 * Compliance teams require a non-empty reason on every rejection so the
 * audit trail explains why a request was denied. The parent passes a
 * minimum length (default 3); the Reject button is disabled until met.
 *
 * Pass 5 — Attendance: migrated to `WorkflowSheet`. Logic, props, and
 * confirm callback shape are unchanged.
 */
import { useEffect, useState } from "react";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display label, e.g. "correction" or "overtime request". */
  kind: string;
  /** When >1 this is a bulk reject; the title pluralizes. */
  count?: number;
  /** Minimum reason length (default 3). */
  minLength?: number;
  /** Called with the trimmed reason once the user confirms. */
  onConfirm: (reason: string) => void | Promise<void>;
  /** True while the parent's mutation is in-flight. */
  isSubmitting?: boolean;
}

export function RejectReasonDialog({
  open,
  onOpenChange,
  kind,
  count = 1,
  minLength = 3,
  onConfirm,
  isSubmitting,
}: Props) {
  const [reason, setReason] = useState("");

  // Clear when the dialog opens so a stale value from a prior reject
  // doesn't auto-fill the next one.
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const trimmed = reason.trim();
  const valid = trimmed.length >= minLength;
  const plural = count > 1;
  const titleNoun = plural ? `${count} ${kind}s` : kind;

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={(o) => !isSubmitting && onOpenChange(o)}
      size="md"
      title={`Reject ${titleNoun}`}
      description={
        <>
          A reason is required so the employee
          {plural ? "s" : ""} understand{plural ? "" : "s"} why this was denied.
          It will appear in the rejection notification.
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!valid || !!isSubmitting}
            onClick={() => onConfirm(trimmed)}
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Reject {plural ? `${count} requests` : ""}
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Reason">
        <WorkflowField
          label="Explanation"
          htmlFor="reject-reason"
          required
          hint={`Minimum ${minLength} characters.`}
        >
          <Textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={`Explain why ${
              plural ? "these requests are" : "this request is"
            } being rejected…`}
            rows={4}
            autoFocus
            disabled={isSubmitting}
          />
        </WorkflowField>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
