/**
 * TimesheetApprovalDialog — approve / reject a submitted timesheet.
 *
 * Migrated to the WorkflowSheet pattern (HR design-system Pass 3).
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { Check, X } from "lucide-react";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { TeamTimesheetSubmission } from "@/hooks/timesheets/useTeamTimesheets";

interface TimesheetApprovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submission: TeamTimesheetSubmission | null;
  action: "approve" | "reject";
  onConfirm: (reason?: string) => Promise<void>;
}

export function TimesheetApprovalDialog({
  open,
  onOpenChange,
  submission,
  action,
  onConfirm,
}: TimesheetApprovalDialogProps) {
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (action === "reject" && !reason.trim()) return;
    setIsSubmitting(true);
    try {
      await onConfirm(reason);
      setReason("");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setReason("");
    onOpenChange(false);
  };

  if (!submission) return null;

  const isApprove = action === "approve";

  const headerRight = (
    <Badge
      variant="outline"
      className={isApprove ? "border-emerald-500 text-emerald-600" : "border-destructive text-destructive"}
    >
      {isApprove ? (
        <Check className="h-3 w-3 mr-1" />
      ) : (
        <X className="h-3 w-3 mr-1" />
      )}
      {isApprove ? "Approve" : "Reject"}
    </Badge>
  );

  const footer = (
    <>
      <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button
        onClick={handleConfirm}
        disabled={isSubmitting || (!isApprove && !reason.trim())}
        variant={isApprove ? "default" : "destructive"}
      >
        {isSubmitting
          ? "Processing..."
          : isApprove
          ? "Approve Timesheet"
          : "Reject Timesheet"}
      </Button>
    </>
  );

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={isApprove ? "Approve Timesheet" : "Reject Timesheet"}
      description={
        isApprove
          ? "Confirm this submission so the hours flow downstream."
          : "Provide a clear reason — the employee will see it."
      }
      headerRight={headerRight}
      footer={footer}
    >
      <WorkflowSheetSection number={1} title="Submission" subtitle="What you're acting on.">
        <div className="rounded-lg border bg-muted/40 p-4 space-y-2">
          <p className="font-medium">
            {submission.employee?.first_name} {submission.employee?.last_name}
          </p>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="secondary">{submission.total_hours}h total</Badge>
            <Badge variant="secondary">{submission.billable_hours}h billable</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {format(new Date(submission.period_start), "MMMM d, yyyy")} –{" "}
            {format(new Date(submission.period_end), "MMMM d, yyyy")}
          </p>
        </div>
      </WorkflowSheetSection>

      {!isApprove && (
        <WorkflowSheetSection number={2} title="Decision" subtitle="Tell the employee why.">
          <WorkflowField label="Rejection reason" htmlFor="rejection-reason" required>
            <Textarea
              id="rejection-reason"
              placeholder="Enter the reason for rejection..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
            />
          </WorkflowField>
        </WorkflowSheetSection>
      )}
    </WorkflowSheet>
  );
}
