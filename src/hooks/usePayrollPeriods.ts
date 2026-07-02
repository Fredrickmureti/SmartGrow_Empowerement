import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface PayrollPeriod {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  period_type: string;
  start_date: string;
  end_date: string;
  payment_date: string | null;
  period_number: number | null;
  fiscal_year: number | null;
  status: string;
  payroll_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export function usePayrollPeriods() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const { data: periods = [], isLoading } = useQuery({
    queryKey: ["payroll-periods", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      // Payroll periods are a strictly company-scoped accounting construct.
      // Closing a period in Company A must never affect Company B. Dropping
      // the previous `.or(business_id.is.null)` branch — period rows always
      // carry a business_id (DB has NOT NULL constraint).
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      const { data, error } = await supabase
        .from("payroll_periods")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("start_date", { ascending: false });

      if (error) throw error;
      return data as PayrollPeriod[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  const generatePeriods = useMutation({
    mutationFn: async ({ year, periodType }: { year: number; periodType: string }) => {
      if (!currentOrg?.id) throw new Error("No organization selected");
      if (!currentBusiness?.id) throw new Error("No company selected — payroll periods are company-scoped");

      const { data, error } = await supabase.rpc("generate_payroll_periods", {
        p_org_id: currentOrg.id,
        p_year: year,
        p_period_type: periodType,
        p_business_id: currentBusiness.id,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["payroll-periods"] });
      toast.success(`Generated ${count} payroll periods`);
    },
    onError: (error) => {
      toast.error(`Failed to generate periods: ${normalizeError(error).message}`);
    },
  });

  // Get open periods available for payroll runs
  const openPeriods = periods.filter((p) => p.status === "open");

  // Get current period (today falls within)
  const getCurrentPeriod = (): PayrollPeriod | undefined => {
    const today = new Date();
    return openPeriods.find(
      (p) =>
        new Date(p.start_date) <= today &&
        new Date(p.end_date) >= today
    );
  };

  /**
   * Close a payroll period AND lock all approved timesheets that fall in
   * the period window. Server-side `lock_timesheets_for_payroll` enforces
   * the role check; we just orchestrate.
   */
  const closePeriod = useMutation({
    mutationFn: async (periodId: string) => {
      const { data: locked, error: lockErr } = await (supabase as any).rpc(
        "lock_timesheets_for_payroll",
        { _payroll_period_id: periodId },
      );
      if (lockErr) throw lockErr;
      const { error } = await supabase
        .from("payroll_periods")
        .update({ status: "closed" } as any)
        .eq("id", periodId);
      if (error) throw error;
      return Number(locked || 0);
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["payroll-periods"] });
      toast.success(`Period closed. ${count} timesheet rows locked.`);
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Failed to close period"),
  });

  /**
   * Reopen a previously closed period (admin-only on the server).
   * Requires a reason for the audit log.
   */
  const reopenPeriod = useMutation({
    mutationFn: async ({ periodId, reason }: { periodId: string; reason: string }) => {
      const { data: unlocked, error: unlockErr } = await (supabase as any).rpc(
        "unlock_timesheets_for_payroll",
        { _payroll_period_id: periodId, _reason: reason },
      );
      if (unlockErr) throw unlockErr;
      const { error } = await supabase
        .from("payroll_periods")
        .update({ status: "open" } as any)
        .eq("id", periodId);
      if (error) throw error;
      return Number(unlocked || 0);
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["payroll-periods"] });
      toast.success(`Period reopened. ${count} timesheet rows unlocked.`);
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Failed to reopen period"),
  });

  return {
    periods,
    openPeriods,
    isLoading,
    generatePeriods,
    closePeriod,
    reopenPeriod,
    getCurrentPeriod,
  };
}
