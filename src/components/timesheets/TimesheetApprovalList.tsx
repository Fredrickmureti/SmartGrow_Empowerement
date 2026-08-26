import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { format } from "date-fns";
import { Check, X, Clock, Calendar, User } from "lucide-react";
import { TeamTimesheetSubmission } from "@/hooks/timesheets/useTeamTimesheets";
import { TimesheetApprovalDialog } from "./TimesheetApprovalDialog";
import type { TimesheetApprovalCapabilityMap } from "@/hooks/timesheets/useTimesheetApprovalCapability";
import { TimesheetAuditPanel } from "./TimesheetAuditPanel";

interface TimesheetApprovalListProps {
  submissions: TeamTimesheetSubmission[];
  /**
   * Server-authoritative verdict per submission (lifecycle + approval
   * competence + Governance self-action policy). The client never derives it.
   */
  capabilities?: TimesheetApprovalCapabilityMap;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string, reason: string) => Promise<void>;
  isLoading?: boolean;
}

export function TimesheetApprovalList({
  submissions,
  capabilities,
  onApprove,
  onReject,
  isLoading,
}: TimesheetApprovalListProps) {
  const [selectedSubmission, setSelectedSubmission] = useState<TeamTimesheetSubmission | null>(null);
  const [dialogAction, setDialogAction] = useState<"approve" | "reject" | null>(null);

  const handleApprove = (submission: TeamTimesheetSubmission) => {
    setSelectedSubmission(submission);
    setDialogAction("approve");
  };

  const handleReject = (submission: TeamTimesheetSubmission) => {
    setSelectedSubmission(submission);
    setDialogAction("reject");
  };

  const handleDialogClose = () => {
    setSelectedSubmission(null);
    setDialogAction(null);
  };

  const handleDialogConfirm = async (reason?: string) => {
    if (!selectedSubmission) return;

    if (dialogAction === "approve") {
      await onApprove(selectedSubmission.id);
    } else if (dialogAction === "reject" && reason) {
      await onReject(selectedSubmission.id, reason);
    }

    handleDialogClose();
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </CardContent>
      </Card>
    );
  }

  if (submissions.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Check className="h-12 w-12 text-green-500 mb-4" />
          <h3 className="text-lg font-medium">All Caught Up!</h3>
          <p className="text-sm text-muted-foreground mt-1">
            No pending timesheets to review.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Pending Timesheet Approvals
          </CardTitle>
          <CardDescription>
            Review and approve or reject timesheet submissions from your team
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {submissions.map((submission) => (
            <div
              key={submission.id}
              className="flex items-start justify-between gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/50"
            >
              <div className="flex items-start gap-4">
                <Avatar className="h-10 w-10">
                  <AvatarFallback>
                    {submission.employee?.first_name?.[0]}
                    {submission.employee?.last_name?.[0]}
                  </AvatarFallback>
                </Avatar>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">
                      {submission.employee?.first_name} {submission.employee?.last_name}
                    </p>
                    <Badge variant="outline">
                      {submission.employee?.employee_number}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {format(new Date(submission.period_start), "MMM d")} -{" "}
                      {format(new Date(submission.period_end), "MMM d, yyyy")}
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {submission.total_hours}h total
                    </div>
                    <div className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {submission.billable_hours}h billable
                    </div>
                  </div>
                  {submission.notes && (
                    <p className="text-sm text-muted-foreground italic">
                      "{submission.notes}"
                    </p>
                  )}
                  {submission.employee_id && (
                    <TimesheetAuditPanel
                      employeeId={submission.employee_id}
                      periodStart={submission.period_start}
                      periodEnd={submission.period_end}
                    />
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                {capabilities?.[submission.id] &&
                  !capabilities[submission.id].canApprove && (
                    <Badge variant="outline" className="text-amber-600 border-amber-300">
                      {capabilities[submission.id].reason === "self_action_blocked"
                        ? "Blocked by Governance"
                        : "Approval not permitted"}
                    </Badge>
                  )}
                {capabilities?.[submission.id]?.requiresOverride &&
                  capabilities[submission.id].canApprove && (
                    <Badge variant="outline" className="text-amber-600 border-amber-300">
                      Governance exception in effect
                    </Badge>
                  )}
                <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={capabilities?.[submission.id]?.canApprove === false}
                  className="text-green-600 hover:text-green-700 hover:bg-green-50"
                  onClick={() => handleApprove(submission)}
                >
                  <Check className="h-4 w-4 mr-1" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={() => handleReject(submission)}
                >
                  <X className="h-4 w-4 mr-1" />
                  Reject
                </Button>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <TimesheetApprovalDialog
        open={dialogAction !== null}
        onOpenChange={(open) => !open && handleDialogClose()}
        submission={selectedSubmission}
        action={dialogAction || "approve"}
        onConfirm={handleDialogConfirm}
      />
    </>
  );
}
