/**
 * useEmployeeCustomDeductions — Slice 2 assignment hook.
 *
 * Each row is one employee's assignment of a `custom_deduction_types`
 * definition. Status transitions are performed via explicit action
 * mutations (approve/activate/suspend/resume/cancel) so the DB event
 * trigger (`employee_custom_deductions_event_trigger`) records intent
 * into `employee_custom_deduction_events`.
 *
 * The compute-payroll edge function reads `('approved','active')` rows
 * whose `[effective_from, effective_to]` covers the run period, applies
 * `cumulative_cap` and `min_net_floor`, then bumps `cumulative_recovered`
 * and auto-flips to `completed` when the cap is reached.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import type { CustomDeductionType } from "./useCustomDeductionTypes";

export type EmployeeCustomDeductionStatus =
  | "pending"
  | "approved"
  | "active"
  | "suspended"
  | "cancelled"
  | "completed";

export interface EmployeeCustomDeduction {
  id: string;
  business_id: string;
  employee_id: string;
  deduction_type_id: string;
  effective_from: string;
  effective_to: string | null;
  amount_override: number | null;
  rate_override: number | null;
  status: EmployeeCustomDeductionStatus;
  cumulative_cap: number | null;
  cumulative_recovered: number;
  min_net_floor: number | null;
  reference: string | null;
  notes: string | null;
  approver_id: string | null;
  approved_at: string | null;
  cancelled_reason: string | null;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // joined
  deduction_type?: CustomDeductionType;
}

export interface EmployeeCustomDeductionEvent {
  id: string;
  assignment_id: string;
  business_id: string;
  event_type: string;
  from_status: EmployeeCustomDeductionStatus | null;
  to_status: EmployeeCustomDeductionStatus | null;
  amount: number | null;
  payroll_run_id: string | null;
  notes: string | null;
  actor_id: string | null;
  created_at: string;
}

const KEY = "employee-custom-deductions";
const EVT_KEY = "employee-custom-deduction-events";

export function useEmployeeCustomDeductions(employeeId: string | undefined) {
  return useQuery({
    queryKey: [KEY, employeeId],
    enabled: !!employeeId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_custom_deductions")
        .select("*, deduction_type:custom_deduction_types(*)")
        .eq("employee_id", employeeId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as EmployeeCustomDeduction[];
    },
  });
}

export function useCustomDeductionEvents(assignmentId: string | undefined) {
  return useQuery({
    queryKey: [EVT_KEY, assignmentId],
    enabled: !!assignmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_custom_deduction_events")
        .select("*")
        .eq("assignment_id", assignmentId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as EmployeeCustomDeductionEvent[];
    },
  });
}

export interface AssignInput {
  employee_id: string;
  deduction_type_id: string;
  effective_from: string;
  effective_to?: string | null;
  amount_override?: number | null;
  rate_override?: number | null;
  cumulative_cap?: number | null;
  min_net_floor?: number | null;
  reference?: string | null;
  notes?: string | null;
  requires_approval: boolean;
}

export function useEmployeeCustomDeductionMutations() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const invalidate = (empId?: string) => {
    qc.invalidateQueries({ queryKey: [KEY, empId] });
    qc.invalidateQueries({ queryKey: [EVT_KEY] });
  };

  const assign = useMutation({
    mutationFn: async (input: AssignInput) => {
      if (!businessId) throw new Error("No business selected");
      const { requires_approval, ...rest } = input;
      const initialStatus: EmployeeCustomDeductionStatus = requires_approval ? "pending" : "approved";
      const { data, error } = await supabase
        .from("employee_custom_deductions")
        .insert({ ...rest, business_id: businessId, status: initialStatus } as never)
        .select()
        .single();
      if (error) throw error;
      return data as unknown as EmployeeCustomDeduction;
    },
    onSuccess: (row) => {
      invalidate(row.employee_id);
      toast.success("Deduction assigned");
    },
    onError: (err) => toast.error(normalizeError(err).message),
  });

  const transition = useMutation({
    mutationFn: async (args: {
      id: string;
      to: EmployeeCustomDeductionStatus;
      reason?: string;
    }) => {
      const patch: Record<string, unknown> = { status: args.to };
      if (args.to === "approved") {
        const { data: sess } = await supabase.auth.getUser();
        patch.approver_id = sess.user?.id ?? null;
        patch.approved_at = new Date().toISOString();
      }
      if (args.to === "cancelled" && args.reason) {
        patch.cancelled_reason = args.reason;
      }
      const { data, error } = await supabase
        .from("employee_custom_deductions")
        .update(patch as never)
        .eq("id", args.id)
        .select()
        .single();
      if (error) throw error;
      return data as unknown as EmployeeCustomDeduction;
    },
    onSuccess: (row) => {
      invalidate(row.employee_id);
      toast.success(`Status → ${row.status}`);
    },
    onError: (err) => toast.error(normalizeError(err).message),
  });

  return { assign, transition };
}
