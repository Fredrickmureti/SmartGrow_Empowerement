import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
import { Check, X, Clock, Calendar, User, MoreHorizontal } from "lucide-react";
import { LeaveRequest } from "@/hooks/leave/useLeaveRequests";
import { LeaveApprovalDialog } from "./LeaveApprovalDialog";
import { usePermissions } from "@/hooks/usePermissions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface LeaveApprovalListProps {
  requests: LeaveRequest[];
  onApprove: (id: string) => Promise<void>;
  onApproveSecondLevel?: (id: string) => Promise<void>;
  onReject: (id: string, reason: string) => Promise<void>;
  isLoading?: boolean;
  /** Multi-select integration — when provided, a checkbox renders per row. */
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
}


const isSecondLevel = (r: LeaveRequest | null) =>
  r?.status === "pending_second_approval";

export function LeaveApprovalList({
  requests,
  onApprove,
  onApproveSecondLevel,
  onReject,
  isLoading,
  selectedIds,
  onToggleSelect,
}: LeaveApprovalListProps) {
  const { can } = usePermissions();
  const canApproveL2 = can("approveLeaveLevel2");
  const showSelect = !!selectedIds && !!onToggleSelect;

  const [selectedRequest, setSelectedRequest] = useState<LeaveRequest | null>(null);
  const [dialogAction, setDialogAction] = useState<"approve" | "reject" | null>(null);

  const handleApprove = (request: LeaveRequest) => {
    // Block the click early when the user lacks final-approval rights —
    // RLS/RPC will also reject, but this gives instant UX feedback.
    if (isSecondLevel(request) && !canApproveL2) return;
    setSelectedRequest(request);
    setDialogAction("approve");
  };

  const handleReject = (request: LeaveRequest) => {
    setSelectedRequest(request);
    setDialogAction("reject");
  };

  const handleDialogClose = () => {
    setSelectedRequest(null);
    setDialogAction(null);
  };

  const handleDialogConfirm = async (reason?: string) => {
    if (!selectedRequest) return;

    if (dialogAction === "approve") {
      if (isSecondLevel(selectedRequest) && onApproveSecondLevel) {
        await onApproveSecondLevel(selectedRequest.id);
      } else {
        await onApprove(selectedRequest.id);
      }
    } else if (dialogAction === "reject" && reason) {
      await onReject(selectedRequest.id, reason);
    }

    handleDialogClose();
  };

  const approveDisabled = (r: LeaveRequest) => isSecondLevel(r) && !canApproveL2;
  const approveLabel = (r: LeaveRequest) =>
    isSecondLevel(r) ? "Final approve" : "Approve";




  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </CardContent>
      </Card>
    );
  }

  if (requests.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center px-4">
          <Check className="h-12 w-12 text-green-500 mb-4" />
          <h3 className="text-lg font-medium">All Caught Up!</h3>
          <p className="text-sm text-muted-foreground mt-1">
            No pending leave requests to review.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2 sm:pb-4">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Clock className="h-4 w-4 sm:h-5 sm:w-5" />
            Pending Approvals
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Review and approve or reject leave requests from your team
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 sm:space-y-4">
          {requests.map((request) => (
            <div
              key={request.id}
              className="rounded-lg border p-3 sm:p-4 transition-colors hover:bg-muted/50"
            >
              {/* Mobile Layout */}
              <div className="flex flex-col gap-3 sm:hidden">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    {showSelect && (
                      <Checkbox
                        checked={selectedIds!.has(request.id)}
                        onCheckedChange={() => onToggleSelect!(request.id)}
                        aria-label={`Select ${request.employee?.first_name ?? "request"}`}
                      />
                    )}
                    <Avatar className="h-10 w-10 flex-shrink-0">
                      <AvatarFallback>
                        {request.employee?.first_name?.[0]}
                        {request.employee?.last_name?.[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {request.employee?.first_name} {request.employee?.last_name}
                      </p>
                      <Badge
                        variant="outline"
                        className="text-xs mt-1"
                        style={{
                          backgroundColor: `${request.leave_type?.color}20`,
                          borderColor: request.leave_type?.color,
                          color: request.leave_type?.color,
                        }}
                      >
                        {request.leave_type?.name}
                      </Badge>
                      {isSecondLevel(request) && (
                        <Badge variant="secondary" className="text-[10px] mt-1 ml-1">
                          Awaiting final approval
                        </Badge>
                      )}
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => handleApprove(request)}
                        disabled={approveDisabled(request)}
                        className="text-green-600"
                      >
                        <Check className="h-4 w-4 mr-2" />
                        {approveLabel(request)}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleReject(request)} className="text-red-600">
                        <X className="h-4 w-4 mr-2" />
                        Reject
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    {format(new Date(request.start_date), "MMM d")} - {format(new Date(request.end_date), "MMM d")}
                  </div>
                  <div className="flex items-center gap-1">
                    <User className="h-3 w-3" />
                    {request.days_requested} day(s)
                  </div>
                </div>
                {request.reason && (
                  <p className="text-xs text-muted-foreground italic line-clamp-2">
                    "{request.reason}"
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 text-green-600 hover:text-green-700 hover:bg-green-50"
                    onClick={() => handleApprove(request)}
                    disabled={approveDisabled(request)}
                    title={approveDisabled(request) ? "Final approval is reserved for owners/admins" : undefined}
                  >
                    <Check className="h-4 w-4 mr-1" />
                    {approveLabel(request)}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={() => handleReject(request)}
                  >
                    <X className="h-4 w-4 mr-1" />
                    Reject
                  </Button>
                </div>
              </div>

              {/* Desktop Layout */}
              <div className="hidden sm:flex items-start justify-between gap-4">
                <div className="flex items-start gap-4 min-w-0">
                  {showSelect && (
                    <Checkbox
                      checked={selectedIds!.has(request.id)}
                      onCheckedChange={() => onToggleSelect!(request.id)}
                      className="mt-2"
                      aria-label={`Select ${request.employee?.first_name ?? "request"}`}
                    />
                  )}
                  <Avatar className="h-10 w-10 flex-shrink-0">
                    <AvatarFallback>
                      {request.employee?.first_name?.[0]}
                      {request.employee?.last_name?.[0]}
                    </AvatarFallback>
                  </Avatar>
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium">
                        {request.employee?.first_name} {request.employee?.last_name}
                      </p>
                      <Badge
                        variant="outline"
                        style={{
                          backgroundColor: `${request.leave_type?.color}20`,
                          borderColor: request.leave_type?.color,
                          color: request.leave_type?.color,
                        }}
                      >
                        {request.leave_type?.name}
                      </Badge>
                      {isSecondLevel(request) && (
                        <Badge variant="secondary">Awaiting final approval</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {format(new Date(request.start_date), "MMM d")} -{" "}
                        {format(new Date(request.end_date), "MMM d, yyyy")}
                      </div>
                      <div className="flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {request.days_requested} day(s)
                      </div>
                    </div>
                    {request.reason && (
                      <p className="text-sm text-muted-foreground italic">
                        "{request.reason}"
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-green-600 hover:text-green-700 hover:bg-green-50"
                    onClick={() => handleApprove(request)}
                    disabled={approveDisabled(request)}
                    title={approveDisabled(request) ? "Final approval is reserved for owners/admins" : undefined}
                  >
                    <Check className="h-4 w-4 mr-1" />
                    {approveLabel(request)}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={() => handleReject(request)}
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

      <LeaveApprovalDialog
        open={dialogAction !== null}
        onOpenChange={(open) => !open && handleDialogClose()}
        request={selectedRequest}
        action={dialogAction || "approve"}
        onConfirm={handleDialogConfirm}
      />
    </>
  );
}
