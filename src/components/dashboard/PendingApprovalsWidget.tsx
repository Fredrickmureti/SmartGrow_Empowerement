import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSalesOrderApproval } from "@/hooks/useSalesOrderApproval";
import { useCurrency } from "@/hooks/useCurrency";
import { CheckCircle, XCircle, Clock, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export function PendingApprovalsWidget() {
  const { pendingApprovals, isLoading, approveOrder, rejectOrder } = useSalesOrderApproval();
  const { formatCurrency } = useCurrency();
  const [actionDialog, setActionDialog] = useState<{
    type: "approve" | "reject";
    approvalId: string;
    soNumber: string;
  } | null>(null);
  const [comments, setComments] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleAction = async () => {
    if (!actionDialog) return;
    setIsSubmitting(true);

    try {
      if (actionDialog.type === "approve") {
        await approveOrder(actionDialog.approvalId, comments || undefined);
      } else {
        await rejectOrder(actionDialog.approvalId, comments || "Rejected by manager");
      }
      setActionDialog(null);
      setComments("");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Pending Approvals
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (pendingApprovals.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Pending Approvals
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No orders pending approval
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Pending Approvals
            <Badge variant="secondary" className="ml-auto">
              {pendingApprovals.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {pendingApprovals.slice(0, 5).map((approval) => (
            <div
              key={approval.id}
              className="flex items-center justify-between p-3 rounded-lg border bg-card"
            >
              <div className="space-y-1">
                <div className="font-medium text-sm">{approval.so_number}</div>
                <div className="text-xs text-muted-foreground">
                  {approval.contact_name || "Walk-in customer"} •{" "}
                  {formatCurrency(approval.total)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(approval.requested_at), { addSuffix: true })}
                </div>
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 text-green-600 hover:text-green-700 hover:bg-green-50"
                  onClick={() =>
                    setActionDialog({
                      type: "approve",
                      approvalId: approval.id,
                      soNumber: approval.so_number,
                    })
                  }
                >
                  <CheckCircle className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() =>
                    setActionDialog({
                      type: "reject",
                      approvalId: approval.id,
                      soNumber: approval.so_number,
                    })
                  }
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
          {pendingApprovals.length > 5 && (
            <p className="text-xs text-muted-foreground text-center">
              +{pendingApprovals.length - 5} more pending
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!actionDialog} onOpenChange={() => setActionDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionDialog?.type === "approve" ? "Approve" : "Reject"} Order
            </DialogTitle>
            <DialogDescription>
              {actionDialog?.type === "approve"
                ? `Approve order ${actionDialog?.soNumber}?`
                : `Reject order ${actionDialog?.soNumber}? Please provide a reason.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>
                {actionDialog?.type === "approve" ? "Comments (optional)" : "Reason"}
              </Label>
              <Textarea
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                placeholder={
                  actionDialog?.type === "approve"
                    ? "Add any comments..."
                    : "Enter reason for rejection..."
                }
                required={actionDialog?.type === "reject"}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              onClick={handleAction}
              disabled={isSubmitting || (actionDialog?.type === "reject" && !comments)}
              variant={actionDialog?.type === "approve" ? "default" : "destructive"}
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {actionDialog?.type === "approve" ? "Approve" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
