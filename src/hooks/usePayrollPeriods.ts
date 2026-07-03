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

  // Periods available for new payroll runs (any non-terminal, non-locked state)
  const OPEN_LIKE = new Set(["open", "preparing", "processing", "awaiting_approval", "reopened"]);
  const openPeriods = periods.filter((p) => OPEN_LIKE.has(p.status));

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
   * Governed close via `payroll_period_close_atomic`:
   *   - runs readiness aggregation
   *   - refuses when blockers exist unless `force` + `overrideReason`
   *   - cascades timesheet lock, transitions status, writes audit + outbox
   * The old two-step (RPC + client UPDATE) flow is deprecated; the DB
   * sentinel now refuses direct status writes.
   */
  const closePeriod = useMutation({
    mutationFn: async ({
      periodId,
      reason,
      force = false,
      overrideReason,
    }: {
      periodId: string;
      reason?: string;
      force?: boolean;
      overrideReason?: string;
    }) => {
      const { data, error } = await (supabase as any).rpc("payroll_period_close_atomic", {
        _period_id: periodId,
        _reason: reason ?? null,
        _force: force,
        _override_reason: overrideReason ?? null,
      });
      if (error) throw error;
      return data as {
        ok: boolean;
        code: "closed" | "blocked";
        timesheets_locked?: number;
        readiness: any;
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["payroll-periods"] });
      if (result?.ok) {
        toast.success(
          `Period closed. ${result.timesheets_locked ?? 0} timesheet rows locked.`,
        );
      } else {
        const blockers = (result?.readiness?.blockers ?? []) as Array<{
          code: string;
          count: number;
        }>;
        const summary = blockers.map((b) => `${b.code} (${b.count})`).join(", ");
        toast.error(`Period close blocked: ${summary || "readiness check failed"}`);
      }
    },
    onError: (e: any) =>
      toast.error(normalizeError(e).message || "Failed to close period"),
  });

  /**
   * Reopen a previously closed period (admin-only on the server).
   * Requires a reason for the audit log.
   */
  const reopenPeriod = useMutation({
    mutationFn: async ({ periodId, reason }: { periodId: string; reason: string }) => {
      const { data, error } = await (supabase as any).rpc("payroll_period_reopen_atomic", {
        _period_id: periodId,
        _reason: reason,
      });
      if (error) throw error;
      return data as { ok: boolean; timesheets_unlocked: number };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["payroll-periods"] });
      toast.success(
        `Period reopened. ${result?.timesheets_unlocked ?? 0} timesheet rows unlocked.`,
      );
    },
    onError: (e: any) =>
      toast.error(normalizeError(e).message || "Failed to reopen period"),
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
