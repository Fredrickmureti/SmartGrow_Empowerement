import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "../usePermissions";
import { toast } from "sonner";

export interface LeaveType {
  id: string;
  organization_id: string;
  name: string;
  code: string;
  color: string;
  description: string | null;
  requires_approval: boolean;
  requires_document: boolean;
  is_paid: boolean;
  max_consecutive_days: number | null;
  min_notice_days: number;
  allow_half_day: boolean;
  accrual_enabled: boolean;
  accrual_rate: number;
  accrual_frequency: string;
  carryover_enabled: boolean;
  carryover_limit: number | null;
  carryover_deadline: string | null;
  negative_balance_allowed: boolean;
  negative_balance_limit: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// SCOPE-EXEMPT: leave_types is intentionally workspace-scoped (no business_id
// column). Leave-type catalogs (Annual, Sick, Maternity…) are HR-policy
// definitions shared across all companies in a workspace. The actual
// leave_requests carry business_id and ARE company-scoped.
export function useLeaveTypes() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { can } = usePermissions();
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchLeaveTypes = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("leave_types")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .order("name");

      if (error) throw error;
      setLeaveTypes((data || []) as LeaveType[]);
    } catch (error) {
      console.error("Error fetching leave types:", error);
      toast.error("Failed to fetch leave types");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    fetchLeaveTypes();
  }, [fetchLeaveTypes]);

  const createLeaveType = async (
    leaveType: Omit<LeaveType, "id" | "organization_id" | "created_at" | "updated_at">
  ) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!can("manageLeaveTypes")) throw new Error("You don't have permission to create leave types");

    const { data, error } = await supabase
      .from("leave_types")
      .insert({
        ...leaveType,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
      })
      .select()
      .single();

    if (error) throw error;

    toast.success("Leave type created successfully");
    await fetchLeaveTypes();
    return data;
  };

  const updateLeaveType = async (id: string, updates: Partial<LeaveType>) => {
    if (!can("manageLeaveTypes")) throw new Error("You don't have permission to update leave types");
    const { error } = await supabase
      .from("leave_types")
      .update(updates)
      .eq("id", id);

    if (error) throw error;

    toast.success("Leave type updated successfully");
    await fetchLeaveTypes();
  };

  const deleteLeaveType = async (id: string) => {
    if (!can("manageLeaveTypes")) throw new Error("You don't have permission to delete leave types");
    const { error } = await supabase
      .from("leave_types")
      .update({ is_active: false })
      .eq("id", id);

    if (error) throw error;

    toast.success("Leave type deleted successfully");
    await fetchLeaveTypes();
  };

  return {
    leaveTypes,
    isLoading,
    createLeaveType,
    updateLeaveType,
    deleteLeaveType,
    refreshLeaveTypes: fetchLeaveTypes,
  };
}
