import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { useCurrentEmployee } from "../useCurrentEmployee";
import { usePermissions } from "../usePermissions";
import { LeaveRequest } from "./useLeaveRequests";

export function useTeamLeaveRequests() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentEmployee, directReports, isManager } = useCurrentEmployee();
  const { can } = usePermissions();
  const [teamLeaveRequests, setTeamLeaveRequests] = useState<LeaveRequest[]>([]);
  const [allLeaveRequests, setAllLeaveRequests] = useState<LeaveRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const canApproveLeave = can("approveLeave");
  const canViewTeamLeave = can("viewTeamLeave");
  const canManageTeam = can("manageTeam");

  const fetchTeamLeaveRequests = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      // If user is admin/HR with full team management, fetch ALL org requests
      if (canApproveLeave) {
        let query = supabase
          .from("leave_requests")
          .select(`
            *,
            employee:employees(id, first_name, last_name, employee_number, department_id),
            leave_type:leave_types(id, name, code, color)
          `)
          .eq("organization_id", currentOrg.id)
          .order("created_at", { ascending: false });

        query = query.eq("business_id", currentBusiness!.id);
        const { data, error } = await query;
        if (error) throw error;

        let filteredData = data || [];

        // Odoo-style department scoping: HR Officers (non-admin) only see
        // leave requests from employees in their own department
        if (!canManageTeam && currentEmployee?.department_id) {
          filteredData = filteredData.filter(
            (r: any) => r.employee?.department_id === currentEmployee.department_id
          );
        }

        setAllLeaveRequests(filteredData as unknown as LeaveRequest[]);
        
        // Approval queue includes both first- and second-level pending items.
        const pending = filteredData.filter(
          (r: any) => r.status === "pending" || r.status === "pending_second_approval"
        );
        setTeamLeaveRequests(pending as unknown as LeaveRequest[]);
      }
      // If user is a manager, fetch only their direct reports' requests
      else if (isManager && currentEmployee) {
        const directReportIds = directReports.map((r) => r.id);
        
        if (directReportIds.length > 0) {
          const { data, error } = await supabase
            .from("leave_requests")
            .select(`
              *,
              employee:employees(id, first_name, last_name, employee_number),
              leave_type:leave_types(id, name, code, color)
            `)
            .eq("organization_id", currentOrg.id)
            .eq("business_id", currentBusiness.id)
            .in("employee_id", directReportIds)
            .order("created_at", { ascending: false });

          if (error) throw error;

          setAllLeaveRequests((data || []) as unknown as LeaveRequest[]);
          
          const pending = (data || []).filter(
            (r: any) => r.status === "pending" || r.status === "pending_second_approval"
          );
          setTeamLeaveRequests(pending as unknown as LeaveRequest[]);
        } else {
          setTeamLeaveRequests([]);
          setAllLeaveRequests([]);
        }
      } else {
        setTeamLeaveRequests([]);
        setAllLeaveRequests([]);
      }
    } catch (error) {
      console.error("Error fetching team leave requests:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, currentEmployee?.id, currentEmployee?.department_id, directReports, isManager, canApproveLeave, canManageTeam]);

  useEffect(() => {
    fetchTeamLeaveRequests();
  }, [fetchTeamLeaveRequests]);

  // Counts for different statuses
  const pendingCount = teamLeaveRequests.length;
  const approvedCount = allLeaveRequests.filter((r) => r.status === "approved").length;
  const rejectedCount = allLeaveRequests.filter((r) => r.status === "rejected").length;

  return {
    teamLeaveRequests, // Pending requests only (for approval queue)
    allLeaveRequests,  // All requests (for history view)
    pendingCount,
    approvedCount,
    rejectedCount,
    isLoading,
    canApproveLeave,
    canViewTeamLeave,
    isManager,
    refreshTeamLeaveRequests: fetchTeamLeaveRequests,
  };
}
