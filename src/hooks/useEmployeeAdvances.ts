/**
 * Employee Advances hook.
 *
 * Backs the first-class `employee_advances` + `advance_repayment_schedule`
 * tables. Compute-payroll consumes approved/disbursed/recovering advances and
 * writes back into `advance_repayment_schedule` + `employee_advances`
 * (recovered_amount, status). This hook owns lifecycle / UI state only.
 */
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export type EmployeeAdvanceStatus =
  | "requested" | "approved" | "disbursed" | "recovering" | "recovered" | "cancelled";
export type AdvanceRecoveryMethod = "lump_sum" | "installments";

export interface EmployeeAdvance {
  id: string;
  organization_id: string;
  business_id: string;
  employee_id: string;
  amount: number;
  currency: string;
  advance_date: string;
  reason: string | null;
  status: EmployeeAdvanceStatus;
  recovery_method: AdvanceRecoveryMethod;
  installment_count: number;
  installment_amount: number | null;
  min_net_floor: number | null;
  requested_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  disbursed_at: string | null;
  recovered_amount: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAdvanceInput {
  business_id: string;
  employee_id: string;
  amount: number;
  currency?: string;
  advance_date?: string;
  reason?: string;
  recovery_method?: AdvanceRecoveryMethod;
  installment_count?: number;
  installment_amount?: number | null;
  min_net_floor?: number | null;
  notes?: string;
}

export function useEmployeeAdvances(businessId?: string | null) {
  const { organization } = useOrganization();
  const { user } = useAuth();
  const [advances, setAdvances] = useState<EmployeeAdvance[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchAdvances = useCallback(async () => {
    if (!organization?.id) return;
    setLoading(true);
    let q = supabase
      .from("employee_advances")
      .select("*")
      .eq("organization_id", organization.id)
      .order("created_at", { ascending: false });
    if (businessId) q = q.eq("business_id", businessId);
    const { data, error } = await q;
    if (error) toast.error(error.message);
    else setAdvances((data as EmployeeAdvance[]) || []);
    setLoading(false);
  }, [organization?.id, businessId]);

  useEffect(() => { fetchAdvances(); }, [fetchAdvances]);

  const createAdvance = useCallback(async (input: CreateAdvanceInput) => {
    if (!organization?.id) throw new Error("No organization");
    const { data, error } = await supabase
      .from("employee_advances")
      .insert({
        organization_id: organization.id,
        business_id: input.business_id,
        employee_id: input.employee_id,
        amount: input.amount,
        currency: input.currency ?? null,
        advance_date: input.advance_date ?? new Date().toISOString().slice(0, 10),
        reason: input.reason ?? null,
        recovery_method: input.recovery_method ?? "lump_sum",
        installment_count: input.installment_count ?? 1,
        installment_amount: input.installment_amount ?? null,
        min_net_floor: input.min_net_floor ?? null,
        notes: input.notes ?? null,
        requested_by: user?.id ?? null,
        status: "requested",
      })
      .select()
      .single();
    if (error) { toast.error(error.message); throw error; }
    await fetchAdvances();
    return data as EmployeeAdvance;
  }, [organization?.id, user?.id, fetchAdvances]);

  const approveAdvance = useCallback(async (id: string) => {
    const { error } = await supabase
      .from("employee_advances")
      .update({ status: "approved", approved_by: user?.id ?? null, approved_at: new Date().toISOString() })
      .eq("id", id);
    if (error) { toast.error(error.message); throw error; }
    await fetchAdvances();
  }, [user?.id, fetchAdvances]);

  /**
   * Disbursement is an accounting event, not a status flip. The canonical
   * `disburse_employee_advance` RPC performs the state transition AND posts
   * the advance-receivable / bank entry through `post_journal_entry_atomic`
   * in one transaction, idempotently. Never write `status = 'disbursed'`
   * from the client — that would move cash with no journal.
   */
  const disburseAdvance = useCallback(
    async (id: string, paymentAccountId?: string | null) => {
      const { error } = await supabase.rpc(
        "disburse_employee_advance" as never,
        {
          p_advance_id: id,
          p_payment_account_id: paymentAccountId ?? null,
        } as never,
      );
      if (error) { toast.error(error.message); throw error; }
      await fetchAdvances();
    },
    [fetchAdvances],
  );


  const cancelAdvance = useCallback(async (id: string) => {
    const { error } = await supabase
      .from("employee_advances")
      .update({ status: "cancelled" })
      .eq("id", id);
    if (error) { toast.error(error.message); throw error; }
    await fetchAdvances();
  }, [fetchAdvances]);

  return { advances, loading, refetch: fetchAdvances, createAdvance, approveAdvance, disburseAdvance, cancelAdvance };
}