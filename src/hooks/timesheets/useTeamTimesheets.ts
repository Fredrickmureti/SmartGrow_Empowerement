import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { useBranches } from "../useBranches";
import { useCurrentEmployee } from "../useCurrentEmployee";
import { usePermissions } from "../usePermissions";
import { useHrScope } from "../hr/useHrScope";
import { applyBranchFilter } from "@/lib/branchScope";
import { TimesheetSubmission } from "./useTimesheets";

export interface TeamTimesheetSubmission extends TimesheetSubmission {
  employee?: {
    id: string;
    first_name: string;
    last_name: string;
    employee_number: string;
  };
}

export function useTeamTimesheets() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { currentEmployee, directReports, isManager } = useCurrentEmployee();
  const { can } = usePermissions();
  const { branchIds, isBranchRestricted } = useHrScope();
  const [teamSubmissions, setTeamSubmissions] = useState<TeamTimesheetSubmission[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const canApproveTimesheets = can("approveTimesheets");
  const canViewTeamTimesheets = can("viewTeamTimesheets");

  const fetchTeamSubmissions = useCallback(async () => {
    if (!currentOrg || !currentBusiness) return;
    setIsLoading(true);

    try {
      if (canApproveTimesheets) {
        let query = supabase
          .from("timesheet_submissions")
          .select(`
            *,
            employee:v_employees_canonical(id, first_name, last_name, employee_number, primary_branch_id, branch_ids)
          `)
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .order("submitted_at", { ascending: false });

        // Server-side branch filter instead of client-side
        query = applyBranchFilter(query, currentBranch?.id);

        const { data, error } = await query;
        if (error) throw error;

        setTeamSubmissions((data || []) as unknown as TeamTimesheetSubmission[]);
      }
      // If user is a manager, fetch only their direct reports' submissions
      else if (isManager && currentEmployee) {
        const directReportIds = directReports.map((r) => r.id);
        
        if (directReportIds.length > 0) {
          const { data, error } = await supabase
            .from("timesheet_submissions")
            .select(`
              *,
              employee:employees(id, first_name, last_name, employee_number)
            `)
            .eq("organization_id", currentOrg.id)
            .eq("business_id", currentBusiness.id)
            .in("employee_id", directReportIds)
            .order("submitted_at", { ascending: false });

          if (error) throw error;

          setTeamSubmissions((data || []) as unknown as TeamTimesheetSubmission[]);
        } else {
          setTeamSubmissions([]);
        }
      } else {
        setTeamSubmissions([]);
      }
    } catch (error) {
      console.error("Error fetching team timesheet submissions:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id, currentEmployee?.id, directReports, isManager, canApproveTimesheets]);

  useEffect(() => {
    fetchTeamSubmissions();
  }, [fetchTeamSubmissions]);

  // Filter submissions by status
  const pendingSubmissions = teamSubmissions.filter((s) => s.status === "submitted");
  const approvedSubmissions = teamSubmissions.filter((s) => s.status === "approved");
  const rejectedSubmissions = teamSubmissions.filter((s) => s.status === "rejected");

  return {
    teamSubmissions,
    pendingSubmissions,
    approvedSubmissions,
    rejectedSubmissions,
    pendingCount: pendingSubmissions.length,
    isLoading,
    canApproveTimesheets,
    canViewTeamTimesheets,
    isManager,
    refreshTeamSubmissions: fetchTeamSubmissions,
  };
}
