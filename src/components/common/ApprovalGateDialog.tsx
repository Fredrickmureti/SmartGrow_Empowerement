/**
 * Approval Gate Dialog
 * 
 * Shown when an action is blocked by an approval rule.
 * Allows the user to request approval.
 */
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, Clock, Send } from "lucide-react";
import { toast } from "sonner";
import { useApprovalGate, ApprovalCheckResult } from "@/hooks/useApprovalGate";

interface ApprovalGateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkResult: ApprovalCheckResult;
  entityType: string;
  actionName: string;
  entityId: string;
  onApprovalRequested?: () => void;
}

export function ApprovalGateDialog({
  open,
  onOpenChange,
  checkResult,
  entityType,
  actionName,
  entityId,
  onApprovalRequested,
}: ApprovalGateDialogProps) {
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { requestApproval } = useApprovalGate();

  const isPending = checkResult.status === "pending";

  const handleRequestApproval = async () => {
    if (!checkResult.ruleId) return;
    setIsSubmitting(true);
    try {
      const logId = await requestApproval(
        entityType,
        actionName,
        entityId,
        checkResult.ruleId,
        notes || undefined
      );

      if (logId) {
        toast.success("Approval request submitted");
        onOpenChange(false);
        onApprovalRequested?.();
      } else {
        toast.error("Failed to submit approval request");
      }
    } catch {
      toast.error("An error occurred");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-full bg-destructive/10 p-2">
              <ShieldAlert className="h-5 w-5 text-destructive" />
            </div>
            <DialogTitle>Approval Required</DialogTitle>
          </div>
          <DialogDescription>
            This action requires approval before it can proceed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Action</span>
              <Badge variant="outline" className="capitalize">
                {actionName.replace(/_/g, " ")}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Entity</span>
              <Badge variant="secondary" className="capitalize">
                {entityType.replace(/_/g, " ")}
              </Badge>
            </div>
            {checkResult.message && (
              <p className="text-sm text-muted-foreground pt-1">
                {checkResult.message}
              </p>
            )}
          </div>

          {isPending ? (
            <div className="flex items-center gap-2 rounded-lg border border-accent bg-accent/50 p-3">
              <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <p className="text-sm text-muted-foreground">
                An approval request has already been submitted and is pending review.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="approval-notes">Notes (optional)</Label>
              <Textarea
                id="approval-notes"
                placeholder="Add context for the approver..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!isPending && (
            <Button
              onClick={handleRequestApproval}
              disabled={isSubmitting}
              className="gap-2"
            >
              <Send className="h-4 w-4" />
              {isSubmitting ? "Submitting..." : "Request Approval"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
