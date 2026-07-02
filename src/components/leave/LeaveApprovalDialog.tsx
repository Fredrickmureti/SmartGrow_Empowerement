import { useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import { LeaveRequest } from "@/hooks/leave/useLeaveRequests";
import { Check, X } from "lucide-react";

interface LeaveApprovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: LeaveRequest | null;
  action: "approve" | "reject";
  onConfirm: (reason?: string) => Promise<void>;
}

export function LeaveApprovalDialog({
  open,
  onOpenChange,
  request,
  action,
  onConfirm,
}: LeaveApprovalDialogProps) {
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (action === "reject" && !reason.trim()) {
      return; // Require reason for rejection
    }

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

  if (!request) return null;

  const isApprove = action === "approve";
  const isFinalApproval = isApprove && request.status === "pending_second_approval";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {isApprove ? (
              <Check className="h-5 w-5 text-green-500" />
            ) : (
              <X className="h-5 w-5 text-red-500" />
            )}
            {isApprove
              ? isFinalApproval
                ? "Grant Final Approval"
                : "Approve Leave Request"
              : "Reject Leave Request"}
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <p>
              {isApprove
                ? isFinalApproval
                  ? "This request has already received first-level approval. Granting final approval will mark it as fully approved and notify the employee."
                  : "Are you sure you want to approve this leave request?"
                : "Please provide a reason for rejecting this leave request."}
            </p>
            <div className="rounded-lg border bg-muted/50 p-4 space-y-2 text-left">
              <p className="font-medium text-foreground">
                {request.employee?.first_name} {request.employee?.last_name}
              </p>
              <p className="text-sm">
                <span className="font-medium">{request.leave_type?.name}</span> •{" "}
                {request.days_requested} day(s)
              </p>
              <p className="text-sm">
                {format(new Date(request.start_date), "MMMM d, yyyy")} -{" "}
                {format(new Date(request.end_date), "MMMM d, yyyy")}
              </p>
              {request.reason && (
                <p className="text-sm italic">Reason: {request.reason}</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {!isApprove && (
          <div className="space-y-2">
            <Label htmlFor="rejection-reason">
              Rejection Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="rejection-reason"
              placeholder="Enter the reason for rejection..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>
        )}

        <AlertDialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isSubmitting || (!isApprove && !reason.trim())}
            className={
              isApprove
                ? "bg-green-600 hover:bg-green-700"
                : "bg-destructive hover:bg-destructive/90"
            }
          >
            {isSubmitting
              ? "Processing..."
              : isApprove
              ? isFinalApproval
                ? "Grant Final Approval"
                : "Approve Request"
              : "Reject Request"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
