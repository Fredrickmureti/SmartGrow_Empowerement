import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "../usePermissions";
import { toast } from "sonner";
import { assertHrScope } from "@/lib/hr/scopingAssertions";
import { dispatchApprovalNotification } from "@/lib/hr/approvalNotifications";

export interface LeaveRequest {
  id: string;
  organization_id: string;
  business_id: string | null;
  employee_id: string;
  leave_type_id: string;
  request_number: string;
  start_date: string;
  end_date: string;
  start_period: string;
  end_period: string;
  days_requested: number;
  reason: string | null;
  attachment_url: string | null;
  status: "draft" | "pending" | "pending_second_approval" | "approved" | "rejected" | "cancelled";
  submitted_at: string | null;
  first_approver_id: string | null;
  first_approval_at: string | null;
  second_approver_id: string | null;
  second_approval_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined data
  employee?: {
    id: string;
    first_name: string;
    last_name: string;
    employee_number: string;
  };
  leave_type?: {
    id: string;
    name: string;
    code: string;
    color: string;
  };
}

export function useLeaveRequests() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { can } = usePermissions();
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchLeaveRequests = useCallback(async () => {
    assertHrScope({ hook: "useLeaveRequests", orgId: currentOrg?.id, businessId: currentBusiness?.id, businessRequired: true });
    if (!currentOrg || !currentBusiness) return;
    setIsLoading(true);

    try {
      const query = supabase
        .from("leave_requests")
        .select(`
          *,
          employee:employees(id, first_name, last_name, employee_number),
          leave_type:leave_types(id, name, code, color)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false })
        .range(0, 4999); // Support up to 5000 leave requests

      const { data, error } = await query;

      if (error) throw error;
      setLeaveRequests((data || []) as unknown as LeaveRequest[]);
    } catch (error) {
      console.error("Error fetching leave requests:", error);
      toast.error("Failed to fetch leave requests");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchLeaveRequests();
  }, [fetchLeaveRequests]);

  const getNextRequestNumber = async (): Promise<string> => {
    if (!currentOrg) return "LR-0001";

    const { data, error } = await supabase.rpc("get_next_leave_request_number", {
      p_org_id: currentOrg.id,
    });

    if (error) {
      console.error("Error getting request number:", error);
      return `LR-${Date.now()}`;
    }

    return data || "LR-0001";
  };

  const calculateLeaveDays = async (
    startDate: string,
    endDate: string,
    startPeriod: string,
    endPeriod: string
  ): Promise<number> => {
    if (!currentOrg) return 0;

    const { data, error } = await supabase.rpc("calculate_leave_days", {
      p_start_date: startDate,
      p_end_date: endDate,
      p_start_period: startPeriod,
      p_end_period: endPeriod,
      p_org_id: currentOrg.id,
    });

    if (error) {
      console.error("Error calculating leave days:", error);
      return 0;
    }

    return data || 0;
  };

  const checkOverlap = async (
    employeeId: string,
    startDate: string,
    endDate: string,
    excludeId?: string
  ): Promise<boolean> => {
    const { data, error } = await supabase.rpc("check_leave_overlap", {
      p_employee_id: employeeId,
      p_start_date: startDate,
      p_end_date: endDate,
      p_exclude_id: excludeId || null,
    });

    if (error) {
      console.error("Error checking overlap:", error);
      return false;
    }

    return data || false;
  };

  const createLeaveRequest = async (
    request: Omit<LeaveRequest, "id" | "organization_id" | "request_number" | "created_at" | "updated_at" | "employee" | "leave_type">,
    options?: { idempotencyKey?: string }
  ) => {
    if (!currentOrg || !user) throw new Error("No organization selected");

    // Ownership validation: if the user is not HR/admin, verify the employee_id belongs to them
    if (!can("manageLeaveTypes")) {
      const { data: ownEmployee } = await supabase
        .from("v_employees_canonical")
        .select("id")
        .eq("user_id", user.id)
        .eq("id", request.employee_id)
        .maybeSingle();

      if (!ownEmployee) {
        toast.error("You can only create leave requests for yourself");
        throw new Error("Employee ownership validation failed");
      }
    }

    // Check for overlap
    const hasOverlap = await checkOverlap(request.employee_id, request.start_date, request.end_date);
    if (hasOverlap) {
      toast.error("This employee already has leave during this period");
      throw new Error("Leave overlap detected");
    }

    const requestNumber = await getNextRequestNumber();

    // Turn J — idempotency key (org + key unique). If a previous submit
    // already created this row, surface it instead of inserting a duplicate.
    if (options?.idempotencyKey) {
      const { data: existing } = await supabase
        .from("leave_requests")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("idempotency_key", options.idempotencyKey)
        .maybeSingle();
      if (existing) {
        await fetchLeaveRequests();
        return existing as any;
      }
    }

    const { data, error } = await supabase
      .from("leave_requests")
      .insert({
        ...request,
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        request_number: requestNumber,
        created_by: user.id,
        idempotency_key: options?.idempotencyKey ?? null,
      })
      .select()
      .single();

    if (error) throw error;

    toast.success(`Leave request ${requestNumber} created successfully`);
    await fetchLeaveRequests();
    return data;
  };

  /**
   * Verify current user owns this leave request (or has HR permission).
   * Defense-in-depth: RLS also enforces this server-side.
   */
  const verifyOwnership = async (requestId: string): Promise<void> => {
    if (can("manageLeaveTypes")) return; // HR/Admin bypass
    if (!user) throw new Error("Not authenticated");

    const request = leaveRequests.find(r => r.id === requestId);
    if (!request) throw new Error("Leave request not found");

    const { data: emp } = await supabase
      .from("v_employees_canonical")
      .select("id")
      .eq("user_id", user.id)
      .eq("id", request.employee_id)
      .maybeSingle();

    if (!emp) {
      toast.error("You can only modify your own leave requests");
      throw new Error("Ownership validation failed");
    }
  };

  const updateLeaveRequest = async (id: string, updates: Partial<LeaveRequest>) => {
    await verifyOwnership(id);

    // Strip joined fields that aren't DB columns
    const { employee, leave_type, ...dbUpdates } = updates as any;

    const { error } = await supabase
      .from("leave_requests")
      .update(dbUpdates)
      .eq("id", id);

    if (error) throw error;

    toast.success("Leave request updated successfully");
    await fetchLeaveRequests();
  };

  const submitRequest = async (id: string) => {
    await verifyOwnership(id);

    const { error } = await supabase
      .from("leave_requests")
      .update({
        status: "pending",
        submitted_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;

    // Unified dispatcher (H1+H2 RPC): notifies approvers (manager + HR module)
    // AND sends the employee a 'submitted' confirmation via the employee-confirm
    // branch. The legacy `send-leave-email` call is no longer needed.
    if (currentOrg?.id) {
      void dispatchApprovalNotification({
        organizationId: currentOrg.id,
        entityType: "leave_request",
        entityId: id,
        event: "submitted",
        actorUserId: user.id,
      });
    }


    toast.success("Leave request submitted for approval");
    await fetchLeaveRequests();
  };

  const approveRequest = async (id: string) => {
    if (!user) throw new Error("Not authenticated");
    if (!can("approveLeave")) throw new Error("You don't have permission to approve leave requests");

    // First-level approval — RPC decides whether the request moves to
    // `approved` or `pending_second_approval` based on the leave type policy.
    const { data, error } = await supabase.rpc("approve_leave_request_level1", {
      p_request_id: id,
    });

    if (error) throw error;

    const nextStatus = (data as any)?.status as string | undefined;
    const goingToL2 = nextStatus === "pending_second_approval";

    // Unified dispatcher: 'approved' notifies the employee (outbound);
    // 'pending_second_approval' notifies L2 approvers + sends an "awaiting
    // final approval" notice to the employee (handled by the H1+H2 RPC).
    if (currentOrg?.id) {
      void dispatchApprovalNotification({
        organizationId: currentOrg.id,
        entityType: "leave_request",
        entityId: id,
        event: goingToL2 ? "pending_second_approval" : "approved",
        actorUserId: user.id,
      });
    }

    toast.success(
      goingToL2
        ? "First-level approval recorded — awaiting final approval"
        : "Leave request approved"
    );
    await fetchLeaveRequests();
  };

  const approveSecondLevel = async (id: string) => {
    if (!user) throw new Error("Not authenticated");
    if (!can("approveLeaveLevel2")) {
      throw new Error("You don't have permission to grant final leave approval");
    }

    const { error } = await supabase.rpc("approve_leave_request_level2", {
      p_request_id: id,
    });

    if (error) throw error;

    if (currentOrg?.id) {
      void dispatchApprovalNotification({
        organizationId: currentOrg.id,
        entityType: "leave_request",
        entityId: id,
        event: "approved",
        actorUserId: user.id,
      });
    }

    toast.success("Leave request fully approved");
    await fetchLeaveRequests();
  };

  const rejectRequest = async (id: string, reason: string) => {
    if (!user) throw new Error("Not authenticated");
    if (!can("approveLeave")) throw new Error("You don't have permission to reject leave requests");

    const { error } = await supabase
      .from("leave_requests")
      .update({
        status: "rejected",
        rejected_by: user.id,
        rejected_at: new Date().toISOString(),
        rejection_reason: reason,
      })
      .eq("id", id);

    if (error) throw error;

    if (currentOrg?.id) {
      void dispatchApprovalNotification({
        organizationId: currentOrg.id,
        entityType: "leave_request",
        entityId: id,
        event: "rejected",
        actorUserId: user.id,
      });
    }

    toast.success("Leave request rejected");
    await fetchLeaveRequests();
  };

  const cancelRequest = async (id: string, reason: string) => {
    await verifyOwnership(id);

    const { error } = await supabase
      .from("leave_requests")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason,
      })
      .eq("id", id);

    if (error) throw error;

    if (currentOrg?.id) {
      void dispatchApprovalNotification({
        organizationId: currentOrg.id,
        entityType: "leave_request",
        entityId: id,
        event: "cancelled",
        actorUserId: user?.id ?? null,
      });
    }

    toast.success("Leave request cancelled");
    await fetchLeaveRequests();
  };

  const deleteLeaveRequest = async (id: string) => {
    if (!can("manageLeaveTypes")) {
      // Non-HR users can only delete their own draft requests
      const request = leaveRequests.find((r) => r.id === id);
      if (!request) throw new Error("Leave request not found");
      
      // Check if this is the user's own request by matching employee user_id
      const { data: emp } = await supabase
        .from("v_employees_canonical")
        .select("id")
        .eq("user_id", user?.id || "")
        .maybeSingle();
      
      if (!emp || request.employee_id !== emp.id) {
        throw new Error("You can only delete your own leave requests");
      }
      if (request.status !== "draft") {
        throw new Error("Only draft leave requests can be deleted");
      }
    }

    const { error } = await supabase.from("leave_requests").delete().eq("id", id);

    if (error) throw error;

    toast.success("Leave request deleted");
    await fetchLeaveRequests();
  };

  return {
    leaveRequests,
    pendingRequests: leaveRequests.filter((r) => r.status === "pending"),
    pendingSecondLevelRequests: leaveRequests.filter(
      (r) => r.status === "pending_second_approval"
    ),
    approvedRequests: leaveRequests.filter((r) => r.status === "approved"),
    isLoading,
    getNextRequestNumber,
    calculateLeaveDays,
    checkOverlap,
    createLeaveRequest,
    updateLeaveRequest,
    submitRequest,
    approveRequest,
    approveSecondLevel,
    rejectRequest,
    cancelRequest,
    deleteLeaveRequest,
    refreshLeaveRequests: fetchLeaveRequests,
  };
}
