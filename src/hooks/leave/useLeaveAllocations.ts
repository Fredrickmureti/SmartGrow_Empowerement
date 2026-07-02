import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "../usePermissions";
import { useSession } from "@/contexts/SessionContext";
import { useCurrentEmployee } from "../useCurrentEmployee";
import { toast } from "sonner";

export interface LeaveAllocation {
  id: string;
  organization_id: string;
  business_id: string | null;
  employee_id: string;
  leave_type_id: string;
  allocation_type: "manual" | "accrual" | "carryover" | "adjustment";
  year: number;
  days_allocated: number;
  days_used: number;
  days_pending: number;
  effective_date: string;
  expiry_date: string | null;
  notes: string | null;
  approved_by: string | null;
  approved_at: string | null;
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

export interface LeaveBalance {
  leave_type_id: string;
  leave_type_name: string;
  leave_type_code: string;
  leave_type_color: string;
  allocated: number;
  used: number;
  pending: number;
  available: number;
}

export function useLeaveAllocations() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { can } = usePermissions();
  const { userType } = useSession();
  const { currentEmployee } = useCurrentEmployee();
  const [allocations, setAllocations] = useState<LeaveAllocation[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAllocations = useCallback(async () => {
    if (!currentOrg) return;
    // Portal users never see the org-wide allocations list. They get balances
    // via getEmployeeBalances scoped to their own employee record.
    if (userType === "portal") {
      if (!currentEmployee?.id) { setAllocations([]); setIsLoading(false); return; }
    }
    setIsLoading(true);

    try {
      let query = (supabase as any)
        .from("leave_allocations")
        .select(`
          *,
          employee:employees(id, first_name, last_name, employee_number),
          leave_type:leave_types(id, name, code, color)
        `)
        .eq("organization_id", currentOrg.id)
        .order("year", { ascending: false });

      if (currentBusiness?.id) {
        query = query.eq("business_id", currentBusiness.id);
      }
      if (userType === "portal" && currentEmployee?.id) {
        query = query.eq("employee_id", currentEmployee.id);
      }
      const { data, error } = await query;

      if (error) throw error;
      setAllocations((data || []) as unknown as LeaveAllocation[]);
    } catch (error) {
      console.error("Error fetching leave allocations:", error);
      // Don't toast for portal users — empty list is fine.
      if (userType !== "portal") {
        toast.error("Failed to fetch leave allocations");
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, userType, currentEmployee?.id]);

  useEffect(() => {
    fetchAllocations();
  }, [fetchAllocations]);

  const getEmployeeBalance = async (
    employeeId: string,
    leaveTypeId: string,
    year?: number
  ): Promise<number> => {
    const { data, error } = await (supabase as any).rpc("get_leave_balance", {
      p_employee_id: employeeId,
      p_leave_type_id: leaveTypeId,
      p_year: year || new Date().getFullYear(),
    });

    if (error) {
      console.error("Error getting leave balance:", error);
      return 0;
    }

    return (data as number) || 0;
  };

  const getEmployeeBalances = async (employeeId: string, year?: number): Promise<LeaveBalance[]> => {
    if (!currentOrg) return [];

    const currentYear = year || new Date().getFullYear();

    // Get all leave types
    let typesQuery = (supabase as any)
      .from("leave_types")
      .select("id, name, code, color")
      .eq("organization_id", currentOrg.id)
      .eq("is_active", true);
    if (currentBusiness?.id) {
      typesQuery = typesQuery.eq("business_id", currentBusiness.id);
    }
    const { data: leaveTypes, error: typesError } = await typesQuery;

    if (typesError || !leaveTypes) return [];

    // Get allocations for this employee and year
    const { data: employeeAllocations, error: allocError } = await (supabase as any)
      .from("leave_allocations")
      .select("*")
      .eq("employee_id", employeeId)
      .eq("year", currentYear);

    if (allocError) return [];

    // Get approved leave requests for this year
    const { data: approvedLeaves, error: leavesError } = await (supabase as any)
      .from("leave_requests")
      .select("leave_type_id, days_requested")
      .eq("employee_id", employeeId)
      .eq("status", "approved")
      .gte("start_date", `${currentYear}-01-01`)
      .lte("start_date", `${currentYear}-12-31`);

    if (leavesError) return [];

    // Get pending leave requests for this year
    const { data: pendingLeaves, error: pendingError } = await (supabase as any)
      .from("leave_requests")
      .select("leave_type_id, days_requested")
      .eq("employee_id", employeeId)
      .eq("status", "pending")
      .gte("start_date", `${currentYear}-01-01`)
      .lte("start_date", `${currentYear}-12-31`);

    if (pendingError) return [];

    // Calculate balances for each leave type
    return (leaveTypes as any[]).map((type: any) => {
      const typeAllocations = (employeeAllocations || []).filter(
        (a: any) => a.leave_type_id === type.id
      );
      const allocated = typeAllocations.reduce((sum: number, a: any) => sum + Number(a.days_allocated), 0);
      const used = (approvedLeaves || [])
        .filter((l: any) => l.leave_type_id === type.id)
        .reduce((sum: number, l: any) => sum + Number(l.days_requested), 0);
      const pending = (pendingLeaves || [])
        .filter((l: any) => l.leave_type_id === type.id)
        .reduce((sum: number, l: any) => sum + Number(l.days_requested), 0);

      return {
        leave_type_id: type.id,
        leave_type_name: type.name,
        leave_type_code: type.code,
        leave_type_color: type.color,
        allocated,
        used,
        pending,
        available: allocated - used,
      };
    });
  };

  const createAllocation = async (
    allocation: Omit<LeaveAllocation, "id" | "organization_id" | "created_at" | "updated_at" | "employee" | "leave_type">
  ) => {
    if (!currentOrg || !user) throw new Error("No organization selected");
    if (!can("manageLeaveTypes")) throw new Error("You don't have permission to create leave allocations");

    const { data, error } = await (supabase as any)
      .from("leave_allocations")
      .insert({
        ...allocation,
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        created_by: user.id,
      })
      .select()
      .single();

    if (error) throw error;

    toast.success("Leave allocation created successfully");
    await fetchAllocations();
    return data;
  };

  const updateAllocation = async (id: string, updates: Partial<LeaveAllocation>) => {
    if (!can("manageLeaveTypes")) throw new Error("You don't have permission to update leave allocations");
    const { error } = await (supabase as any)
      .from("leave_allocations")
      .update(updates)
      .eq("id", id);

    if (error) throw error;

    toast.success("Leave allocation updated successfully");
    await fetchAllocations();
  };

  const deleteAllocation = async (id: string) => {
    if (!can("manageLeaveTypes")) throw new Error("You don't have permission to delete leave allocations");
    const { error } = await (supabase as any).from("leave_allocations").delete().eq("id", id);

    if (error) throw error;

    toast.success("Leave allocation deleted");
    await fetchAllocations();
  };

  const bulkAllocate = async (
    employeeIds: string[],
    leaveTypeId: string,
    daysAllocated: number,
    year: number
  ) => {
    if (!currentOrg || !user) throw new Error("No organization selected");
    if (!can("manageLeaveTypes")) throw new Error("You don't have permission to bulk allocate leave");

    const allocationsToInsert = employeeIds.map((employeeId) => ({
      organization_id: currentOrg.id,
      business_id: currentBusiness?.id || null,
      employee_id: employeeId,
      leave_type_id: leaveTypeId,
      allocation_type: "manual" as const,
      year,
      days_allocated: daysAllocated,
      days_used: 0,
      days_pending: 0,
      effective_date: new Date().toISOString().split("T")[0],
      created_by: user.id,
    }));

    const { error } = await (supabase as any).from("leave_allocations").insert(allocationsToInsert);

    if (error) throw error;

    toast.success(`Leave allocated to ${employeeIds.length} employees`);
    await fetchAllocations();
  };

  return {
    allocations,
    isLoading,
    getEmployeeBalance,
    getEmployeeBalances,
    createAllocation,
    updateAllocation,
    deleteAllocation,
    bulkAllocate,
    refreshAllocations: fetchAllocations,
  };
}
