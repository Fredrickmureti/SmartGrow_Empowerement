import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { useBranches } from "../useBranches";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "../usePermissions";
import { applyBranchFilter } from "@/lib/branchScope";
import { toast } from "sonner";
import { format, subWeeks, addWeeks, startOfWeek } from "date-fns";
import { dispatchApprovalNotification } from "@/lib/hr/approvalNotifications";
import {
  insertTimesheet as writeInsertTimesheet,
  insertTimesheets,
  updateTimesheet as writeUpdateTimesheet,
  deleteTimesheet as writeDeleteTimesheet,
  type TimesheetDraft,
} from "@/lib/timesheets/timesheetWriter";


export interface Timesheet {
  id: string;
  organization_id: string;
  business_id: string | null;
  employee_id: string;
  project_id: string | null;
  task_id: string | null;
  date: string;
  hours: number;
  start_time?: string | null;
  end_time?: string | null;
  description: string | null;
  is_billable: boolean;
  billing_rate: number | null;
  billing_amount: number | null;
  status: "draft" | "submitted" | "approved" | "rejected" | "superseded";
  submitted_at: string | null;
  submitted_by?: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  invoice_id: string | null;
  is_invoiced: boolean;
  payroll_period_id?: string | null;
  payroll_locked?: boolean;
  correction_of?: string | null;
  created_by: string | null;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
  // Joined data
  employee?: {
    id: string;
    first_name: string;
    last_name: string;
    employee_number: string;
  };
  project?: {
    id: string;
    name: string;
    project_number: string;
  };
  task?: {
    id: string;
    name: string;
    task_number: string;
  };
}

export interface TimesheetSubmission {
  id: string;
  organization_id: string;
  business_id: string | null;
  employee_id: string;
  period_start: string;
  period_end: string;
  total_hours: number;
  billable_hours: number;
  status: "draft" | "submitted" | "approved" | "rejected";
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export function useTimesheets() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { user } = useAuth();
  const { can } = usePermissions();
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [submissions, setSubmissions] = useState<TimesheetSubmission[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchTimesheets = useCallback(async (startDate?: string, endDate?: string) => {
    if (!currentOrg || !currentBusiness) return;
    setIsLoading(true);

    // Default window: 8 weeks back, 2 weeks forward (avoids loading years of data)
    const defaultStart = startDate ?? format(subWeeks(startOfWeek(new Date()), 8), "yyyy-MM-dd");
    const defaultEnd = endDate ?? format(addWeeks(new Date(), 2), "yyyy-MM-dd");

    try {
      let query = supabase
        .from("timesheets")
        .select(`
          *,
          employee:employees(id, first_name, last_name, employee_number),
          project:projects(id, name, project_number),
          task:project_tasks(id, name, task_number)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .gte("date", defaultStart)
        .lte("date", defaultEnd)
        .order("date", { ascending: false });

      query = applyBranchFilter(query, currentBranch?.id);

      const { data, error } = await query;

      if (error) throw error;
      setTimesheets((data || []) as unknown as Timesheet[]);
    } catch (error) {
      console.error("Error fetching timesheets:", error);
      toast.error("Failed to fetch timesheets");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

  const fetchSubmissions = useCallback(async () => {
    if (!currentOrg || !currentBusiness) return;

    try {
      let query = supabase
        .from("timesheet_submissions")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("period_start", { ascending: false });

      query = applyBranchFilter(query, currentBranch?.id);
      const { data, error } = await query;

      if (error) throw error;
      setSubmissions((data || []) as TimesheetSubmission[]);
    } catch (error) {
      console.error("Error fetching timesheet submissions:", error);
    }
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

  useEffect(() => {
    fetchTimesheets();
    fetchSubmissions();
  }, [fetchTimesheets, fetchSubmissions]);

  const getEmployeeHours = async (
    employeeId: string,
    startDate: string,
    endDate: string
  ): Promise<number> => {
    const { data, error } = await supabase.rpc("get_employee_hours_in_period", {
      p_employee_id: employeeId,
      p_start_date: startDate,
      p_end_date: endDate,
    });

    if (error) {
      console.error("Error getting employee hours:", error);
      return 0;
    }

    return data || 0;
  };

  const writeScope = {
    organizationId: currentOrg?.id ?? "",
    businessId: currentBusiness?.id ?? null,
    userId: user?.id ?? null,
  };

  const createTimesheet = async (
    timesheet: Omit<Timesheet, "id" | "organization_id" | "created_at" | "updated_at" | "employee" | "project" | "task">
  ) => {
    if (!currentOrg || !user) throw new Error("No organization selected");

    const data = await writeInsertTimesheet(writeScope, timesheet as unknown as TimesheetDraft);

    toast.success("Time entry created successfully");
    await fetchTimesheets();
    return data;
  };

  const updateTimesheet = async (id: string, updates: Partial<Timesheet>) => {
    await writeUpdateTimesheet(id, updates as unknown as Record<string, unknown>);

    toast.success("Time entry updated successfully");
    await fetchTimesheets();
  };

  const deleteTimesheet = async (id: string) => {
    await writeDeleteTimesheet(id);

    toast.success("Time entry deleted");
    await fetchTimesheets();
  };


  /** Submit a period via the server RPC (atomic). */
  const submitTimesheets = async (
    employeeId: string,
    periodStart: string,
    periodEnd: string,
    notes?: string,
  ) => {
    const { error } = await supabase.rpc("submit_timesheet_period" as any, {
      _employee_id: employeeId,
      _period_start: periodStart,
      _period_end: periodEnd,
      _notes: notes ?? null,
    });
    if (error) throw error;
    toast.success("Timesheet submitted for approval");
    await fetchTimesheets();
    await fetchSubmissions();
  };

  /** Approve a submission server-side (permission check is server-enforced). */
  const approveTimesheets = async (submissionId: string) => {
    const { error } = await supabase.rpc("approve_timesheet_submission" as any, {
      _submission_id: submissionId,
    });
    if (error) throw error;
    toast.success("Timesheet approved");
    if (currentOrg?.id) {
      void dispatchApprovalNotification({
        organizationId: currentOrg.id,
        entityType: "timesheet_submission",
        entityId: submissionId,
        event: "approved",
        actorUserId: user?.id ?? null,
      });
    }
    await fetchTimesheets();
    await fetchSubmissions();
  };

  const rejectTimesheets = async (submissionId: string, reason: string) => {
    const { error } = await supabase.rpc("reject_timesheet_submission" as any, {
      _submission_id: submissionId,
      _reason: reason,
    });
    if (error) throw error;
    toast.success("Timesheet rejected");
    if (currentOrg?.id) {
      void dispatchApprovalNotification({
        organizationId: currentOrg.id,
        entityType: "timesheet_submission",
        entityId: submissionId,
        event: "rejected",
        actorUserId: user?.id ?? null,
      });
    }
    await fetchTimesheets();
    await fetchSubmissions();
  };

  /**
   * Correct an approved entry. The server creates a linked draft correction
   * entry; the original stays an immutable historical fact until the
   * correction is approved, at which point it is superseded.
   */
  const correctTimesheet = async (
    timesheetId: string,
    reason: string,
    changes?: {
      hours?: number;
      description?: string | null;
      is_billable?: boolean;
      project_id?: string | null;
      task_id?: string | null;
    },
  ) => {
    const { data, error } = await supabase.rpc("correct_timesheet_entry" as any, {
      _timesheet_id: timesheetId,
      _reason: reason,
      _hours: changes?.hours ?? null,
      _description: changes?.description ?? null,
      _is_billable: changes?.is_billable ?? null,
      _project_id: changes?.project_id ?? null,
      _task_id: changes?.task_id ?? null,
    });
    if (error) throw error;
    toast.success("Correction created — submit it for approval to replace the original entry");
    await fetchTimesheets();
    return data as unknown as string;
  };

  /** Reverse an approved entry (no replacement). Requires a reason. */
  const reverseTimesheet = async (timesheetId: string, reason: string) => {
    const { error } = await supabase.rpc("reverse_timesheet_entry" as any, {
      _timesheet_id: timesheetId,
      _reason: reason,
    });
    if (error) throw error;
    toast.success("Time entry reversed");
    await fetchTimesheets();
  };

  /**
   * Copy every entry from `fromWeekStart` (7 days) into the matching weekday of
   * `toWeekStart`. Useful for repeating a typical week. Skips weekends with no
   * source entries; only `draft` rows are produced (so they need re-submitting).
   */
  const copyPreviousWeek = async (
    employeeId: string,
    fromWeekStart: string,
    toWeekStart: string,
  ) => {
    const fromStart = new Date(fromWeekStart);
    const fromEnd = new Date(fromStart); fromEnd.setDate(fromStart.getDate() + 6);
    const source = timesheets.filter(
      (t) =>
        t.employee_id === employeeId &&
        new Date(t.date) >= fromStart &&
        new Date(t.date) <= fromEnd,
    );
    if (source.length === 0) {
      toast.info("Previous week has no entries to copy");
      return 0;
    }
    const offsetDays =
      (new Date(toWeekStart).getTime() - fromStart.getTime()) / (1000 * 60 * 60 * 24);
    const drafts: TimesheetDraft[] = source.map((t) => {
      const d = new Date(t.date); d.setDate(d.getDate() + offsetDays);
      return {
        employee_id: t.employee_id,
        project_id: t.project_id,
        task_id: t.task_id,
        date: d.toISOString().slice(0, 10),
        hours: t.hours,
        description: t.description,
        status: "draft" as const,
      };
    });
    const inserted = await insertTimesheets(writeScope, drafts);
    toast.success(`Copied ${inserted} entries from last week`);
    await fetchTimesheets();
    return inserted;

  };

  return {
    timesheets,
    submissions,
    pendingSubmissions: submissions.filter((s) => s.status === "submitted"),
    isLoading,
    getEmployeeHours,
    createTimesheet,
    updateTimesheet,
    deleteTimesheet,
    submitTimesheets,
    approveTimesheets,
    rejectTimesheets,
    copyPreviousWeek,
    refreshTimesheets: fetchTimesheets,
    refreshSubmissions: fetchSubmissions,
  };
}
