/**
 * Employee branch assignments (Phase C — HR Architecture Review).
 *
 * Branch is a 0..N *assignment* on an employee, not an ownership column.
 * This hook is the single read/write surface for the
 * `employee_branch_assignments` table and the three RPCs that maintain it.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type AssignmentType = "permanent" | "secondment" | "temporary" | "coverage";

export interface EmployeeBranchAssignment {
  id: string;
  employee_id: string;
  branch_id: string;
  is_primary: boolean;
  effective_from: string;
  effective_to: string | null;
  assignment_type: AssignmentType;
  notes: string | null;
  created_at: string;
  branch_name?: string | null;
}

export function useEmployeeBranchAssignments(employeeId: string | null | undefined) {
  const [assignments, setAssignments] = useState<EmployeeBranchAssignment[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchAssignments = useCallback(async () => {
    if (!employeeId) {
      setAssignments([]);
      return;
    }
    setIsLoading(true);
    try {
      const { data, error } = await (supabase as any)
        .from("employee_branch_assignments")
        .select("*, branch:branches(name)")
        .eq("employee_id", employeeId)
        .order("is_primary", { ascending: false })
        .order("effective_from", { ascending: false });
      if (error) throw error;
      const rows = ((data ?? []) as any[]).map((r) => ({
        ...r,
        branch_name: r.branch?.name ?? null,
      }));
      setAssignments(rows as EmployeeBranchAssignment[]);
    } catch (e: any) {
      console.error("Failed to load branch assignments", e);
      toast.error(e?.message || "Failed to load branch assignments");
    } finally {
      setIsLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    fetchAssignments();
  }, [fetchAssignments]);

  const assign = async (params: {
    branchId: string;
    isPrimary: boolean;
    effectiveFrom?: string;
    assignmentType?: AssignmentType;
    notes?: string;
  }) => {
    if (!employeeId) throw new Error("No employee");
    const { error } = await supabase.rpc("assign_employee_to_branch" as any, {
      p_employee_id: employeeId,
      p_branch_id: params.branchId,
      p_is_primary: params.isPrimary,
      p_effective_from: params.effectiveFrom ?? new Date().toISOString().slice(0, 10),
      p_assignment_type: params.assignmentType ?? "permanent",
      p_notes: params.notes ?? null,
    });
    if (error) throw error;
    toast.success("Branch assigned");
    await fetchAssignments();
  };

  const end = async (assignmentId: string, effectiveTo?: string) => {
    const { error } = await supabase.rpc("end_employee_branch_assignment" as any, {
      p_assignment_id: assignmentId,
      p_effective_to: effectiveTo ?? new Date().toISOString().slice(0, 10),
    });
    if (error) throw error;
    toast.success("Assignment ended");
    await fetchAssignments();
  };

  const transferPrimary = async (newBranchId: string, effectiveFrom?: string) => {
    if (!employeeId) throw new Error("No employee");
    const { error } = await supabase.rpc("transfer_employee_primary_branch" as any, {
      p_employee_id: employeeId,
      p_new_branch_id: newBranchId,
      p_effective_from: effectiveFrom ?? new Date().toISOString().slice(0, 10),
    });
    if (error) throw error;
    toast.success("Primary branch transferred");
    await fetchAssignments();
  };

  return {
    assignments,
    activeAssignments: assignments.filter((a) => !a.effective_to),
    isLoading,
    refresh: fetchAssignments,
    assign,
    end,
    transferPrimary,
  };
}
