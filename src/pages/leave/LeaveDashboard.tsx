/**
 * LeaveDashboard — Time Off overview page (index of /hr/leave/*).
 *
 * This page is the manager + employee command center. Approvals and the team
 * calendar have been promoted to their own routes (/hr/leave/approvals,
 * /hr/leave/calendar) so the overview stays focused on:
 *   - quick request CTA
 *   - the current user's balances
 *   - their recent request history
 *
 * The inner Tabs/Approvals/TeamCalendar blocks were extracted to dedicated
 * pages; the sub-nav exposes them. Settings and report-export remain here.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Calendar, Clock, CheckCircle, Settings } from "lucide-react";
import { useLeaveRequests, useLeaveTypes, useTeamLeaveRequests } from "@/hooks/leave";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useLeaveAllocations, LeaveBalance } from "@/hooks/leave/useLeaveAllocations";
import { usePermissions } from "@/hooks/usePermissions";
import { useState, useEffect } from "react";
import { LeaveRequestForm } from "@/components/leave/LeaveRequestForm";
import { LeaveBalanceCard } from "@/components/leave/LeaveBalanceCard";
import { LeaveTypeSettingsDialog } from "@/components/leave/LeaveTypeSettingsDialog";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { PermissionGate } from "@/components/common/PermissionGate";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { useOrganization } from "@/hooks/useOrganization";

export default function LeaveDashboard() {
  const {
    leaveRequests,
    pendingRequests,
    approvedRequests,
    isLoading: requestsLoading,
  } = useLeaveRequests();
  const { leaveTypes, isLoading: typesLoading } = useLeaveTypes();
  const { allLeaveRequests, canApproveLeave, isManager } = useTeamLeaveRequests();
  const { currentEmployee, isLoading: employeeLoading } = useCurrentEmployee();
  const { can } = usePermissions();
  const { getEmployeeBalances } = useLeaveAllocations();
  const { currentOrg } = useOrganization();
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalance[]>([]);

  useEffect(() => {
    if (currentEmployee?.id) {
      getEmployeeBalances(currentEmployee.id).then(setLeaveBalances);
    }
  }, [currentEmployee?.id]);

  const upcomingLeave = approvedRequests.filter(
    (r) => new Date(r.start_date) >= new Date(),
  );
  const showManagerView = canApproveLeave || isManager;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return (
          <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/20">
            Pending
          </Badge>
        );
      case "approved":
        return (
          <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20">
            Approved
          </Badge>
        );
      case "rejected":
        return (
          <Badge variant="outline" className="bg-red-500/10 text-red-600 border-red-500/20">
            Rejected
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (requestsLoading || typesLoading || employeeLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Leave Management</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            {showManagerView
              ? "Manage team leave and your own time off"
              : "Request and track your time off"}
          </p>
        </div>
        <div className="action-buttons w-full sm:w-auto">
          <ReportExportButtons
            getExportConfig={() =>
              ({
                title: "Leave Requests Report",
                companyName: currentOrg?.name || undefined,
                dateRange: `As of ${format(new Date(), "MMM d, yyyy")}`,
                columns: [
                  { key: "employee", header: "Employee", width: 22 },
                  { key: "leave_type", header: "Leave Type", width: 16 },
                  { key: "start_date", header: "Start Date", width: 14 },
                  { key: "end_date", header: "End Date", width: 14 },
                  { key: "days", header: "Days", format: "number", width: 8, align: "right" },
                  { key: "status", header: "Status", width: 10 },
                  { key: "reason", header: "Reason", width: 24 },
                ],
                rows: (allLeaveRequests || leaveRequests).map((r: any) => ({
                  employee: r.employee ? `${r.employee.first_name} ${r.employee.last_name}` : "—",
                  leave_type: r.leave_type?.name || "Leave",
                  start_date: format(new Date(r.start_date), "MMM d, yyyy"),
                  end_date: format(new Date(r.end_date), "MMM d, yyyy"),
                  days: r.days_requested,
                  status: r.status || "draft",
                  reason: r.reason || "—",
                })),
                organizationId: currentOrg?.id,
              }) as ExportConfig
            }
            formats={["excel", "csv", "pdf"]}
            compact
          />
          {can("manageLeaveTypes") && (
            <Button
              variant="outline"
              onClick={() => setShowSettingsDialog(true)}
              className="flex-1 sm:flex-none"
            >
              <Settings className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Settings</span>
            </Button>
          )}
          <PermissionGate permission="viewLeave">
            <Button onClick={() => setShowRequestForm(true)} className="flex-1 sm:flex-none">
              <Plus className="h-4 w-4 sm:mr-2" />
              <span className="hidden xs:inline">Request Leave</span>
              <span className="xs:hidden">Request</span>
            </Button>
          </PermissionGate>
        </div>
      </div>

      <div className="stats-grid">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Requests</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="stat-value">{pendingRequests.length}</div>
            <p className="text-xs text-muted-foreground">Awaiting approval</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Approved</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="stat-value">{approvedRequests.length}</div>
            <p className="text-xs text-muted-foreground">This year</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Upcoming Leave</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="stat-value">{upcomingLeave.length}</div>
            <p className="text-xs text-muted-foreground">Scheduled days off</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Leave Types</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="stat-value">{leaveTypes.length}</div>
            <p className="text-xs text-muted-foreground">Available types</p>
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-lg sm:text-xl font-semibold mb-3 sm:mb-4">Leave Balances</h2>
        <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {leaveTypes.map((type) => {
            const balance = leaveBalances.find((b) => b.leave_type_id === type.id);
            return (
              <LeaveBalanceCard
                key={type.id}
                leaveType={type}
                allocated={balance?.allocated ?? 0}
                used={balance?.used ?? 0}
                pending={balance?.pending ?? 0}
              />
            );
          })}
          {leaveTypes.length === 0 && (
            <Card className="col-span-full">
              <CardContent className="flex items-center justify-center py-8 text-muted-foreground text-sm sm:text-base">
                No leave types configured. Contact your administrator.
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2 sm:pb-4">
          <CardTitle className="text-base sm:text-lg">My Requests</CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Your leave request history
          </CardDescription>
        </CardHeader>
        <CardContent>
          {leaveRequests.length === 0 ? (
            <div className="text-center py-6 sm:py-8 text-muted-foreground text-sm">
              No leave requests yet. Click "Request Leave" to create one.
            </div>
          ) : (
            <div className="space-y-3 sm:space-y-4">
              {leaveRequests.slice(0, 5).map((request) => (
                <div
                  key={request.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 border-b pb-3 sm:pb-4 last:border-0"
                >
                  <div className="space-y-1 min-w-0">
                    <p className="font-medium text-sm sm:text-base truncate">
                      {request.leave_type?.name || "Leave"}
                    </p>
                    <p className="text-xs sm:text-sm text-muted-foreground">
                      {format(new Date(request.start_date), "MMM d, yyyy")} -{" "}
                      {format(new Date(request.end_date), "MMM d, yyyy")}
                    </p>
                    {request.reason && (
                      <p className="text-xs sm:text-sm text-muted-foreground line-clamp-1">
                        {request.reason}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 sm:gap-4 justify-between sm:justify-end">
                    <span className="text-xs sm:text-sm font-medium">
                      {request.days_requested} days
                    </span>
                    {getStatusBadge(request.status || "draft")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <LeaveRequestForm open={showRequestForm} onOpenChange={setShowRequestForm} />
      <LeaveTypeSettingsDialog
        open={showSettingsDialog}
        onOpenChange={setShowSettingsDialog}
      />
    </div>
  );
}
