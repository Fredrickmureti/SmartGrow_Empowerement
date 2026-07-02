/**
 * useLoanSkipOverrides — Loan Skip Overrides operational console hook.
 *
 * Backs the maker-checker workflow over `payroll_run_loan_skip_overrides`:
 *  - submit (insert)
 *  - approve / reject / cancel (RPCs; segregation-of-duties enforced server-side)
 *  - read overrides for an org, optionally scoped to a payroll run.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type LoanSkipOverrideStatus =
  | "pending" | "approved" | "rejected" | "cancelled" | "expired" | "consumed";

export interface LoanSkipOverride {
  id: string;
  organization_id: string;
  business_id: string | null;
  payroll_run_id: string;
  loan_id: string;
  schedule_id: string;
  employee_id: string;
  reason: string;
  reason_category: string | null;
  evidence_url: string | null;
  status: LoanSkipOverrideStatus;
  source: "user" | "hr_event" | "system";
  source_event_id: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  consumed_at: string | null;
  consumed_payslip_id: string | null;
  created_at: string;
  updated_at: string;
}

export function useLoanSkipOverrides(payrollRunId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: overrides = [], isLoading } = useQuery({
    queryKey: ["loan-skip-overrides", currentOrg?.id, payrollRunId ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("payroll_run_loan_skip_overrides")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });
      if (payrollRunId) q = q.eq("payroll_run_id", payrollRunId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as LoanSkipOverride[];
    },
    enabled: !!currentOrg?.id,
  });

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["loan-skip-overrides"] }),
      // Readiness findings reference these overrides via the four
      // run.loan_skip_override_* rules; refresh whatever surfaces them.
      qc.invalidateQueries({ queryKey: ["payroll-readiness"] }),
      qc.invalidateQueries({ queryKey: ["payroll-readiness-findings"] }),
    ]);

  const createOverride = useMutation({
    mutationFn: async (input: {
      payroll_run_id: string;
      loan_id: string;
      schedule_id: string;
      employee_id: string;
      reason: string;
      reason_category?: string;
      evidence_url?: string;
    }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id;
      if (!userId) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("payroll_run_loan_skip_overrides")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id ?? null,
          created_by: userId,
          source: "user",
          status: "pending",
          ...input,
        } as any)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Override submitted for approval");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const approveOverride = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("loan_skip_override_approve", { _override_id: id } as any);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); toast.success("Override approved"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const rejectOverride = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("loan_skip_override_reject", { _override_id: id, _reason: reason } as any);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); toast.success("Override rejected"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const cancelOverride = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("loan_skip_override_cancel", { _override_id: id, _reason: reason } as any);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); toast.success("Override cancelled"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  // Pending-only delete for accidental drafts (matches DB delete trigger which forbids non-pending deletes)
  const deleteOverride = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("payroll_run_loan_skip_overrides")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); toast.success("Draft override removed"); },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return {
    overrides,
    isLoading,
    createOverride,
    approveOverride,
    rejectOverride,
    cancelOverride,
    deleteOverride,
  };
}
