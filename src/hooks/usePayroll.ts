import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Employee } from "./useEmployees";
import { usePermissions } from "./usePermissions";
import { useAuditLog } from "./useAuditLog";
import { assertHrScope } from "@/lib/hr/scopingAssertions";

export interface PayrollRun {
  id: string;
  organization_id: string;
  business_id?: string | null;
  payroll_number: string;
  pay_period_start: string;
  pay_period_end: string;
  payment_date: string | null;
  status: string;
  total_gross: number;
  total_other_deductions: number;
  total_net: number;
  total_employer_contributions: number;
  employee_count: number;
  notes: string | null;
  approved_by: string | null;
  approved_at: string | null;
  /** User who created this payroll run (for maker-checker enforcement) */
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Generic deductions aggregated by rule_code (authoritative) */
  deductions_summary: Record<string, number>;
  /** Generic employer contributions aggregated by rule_code (authoritative) */
  contributions_summary: Record<string, number>;
  /** Reversal lineage — true if this run was created by payroll_reverse_run_atomic. */
  is_reversal?: boolean | null;
  /** Lifecycle tag: 'regular' | 'correction'. Correction = signed delta run. */
  run_type?: string | null;
  /** Points to the parent run when this row is a reversal/correction. */
  original_run_id?: string | null;
  /** Set when this run has been reversed. Mirrors payroll_runs.reversed_at. */
  reversed_at?: string | null;
  reversed_by?: string | null;
  reversal_reason?: string | null;
}

export interface Payslip {
  id: string;
  payroll_run_id: string;
  employee_id: string;
  organization_id: string;
  // Phase 4 P1.2c: payslip header carries only universal totals + lineage.
  // Per-component decomposition (basic, allowances, statutory, employer
  // contributions, etc.) lives exclusively in `payslip_lines` — the single
  // source of truth. Do NOT add country-typed columns here.
  gross_pay: number;
  total_deductions: number;
  net_pay: number;
  status: string;
  paid_at: string | null;
  payment_reference: string | null;
  employee?: Employee;
  /** Generic employee deductions keyed by rule_code (sourced from payslip_lines) */
  deductions_detail: Record<string, number>;
  /** Generic employer contributions keyed by rule_code (sourced from payslip_lines) */
  contributions_detail: Record<string, number>;
  /**
   * Phase 3.4 — Correction Delta lineage.
   * On a `run_type='correction'` run, this points to the payslip in the
   * parent run whose values were subtracted to produce this signed delta.
   * NULL on regular/bonus/termination runs. UI surfaces this as a
   * "Δ vs parent" badge with a link back to the parent payslip.
   */
  retro_of_payslip_id?: string | null;
}

import {
  type PayrollRuleSet,
} from "./usePayrollStatutoryRules";

export interface VariableEarningsInput {
  employee_id: string;
  overtime_pay?: number;
  bonus?: number;
  commission?: number;
  arrears?: number;
  [key: string]: any;
}

export function usePayroll() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { can } = usePermissions();
  const { logAction } = useAuditLog();
  const [payrollRuns, setPayrollRuns] = useState<PayrollRun[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPayrollRuns = useCallback(async () => {
    assertHrScope({ hook: "usePayroll", orgId: currentOrg?.id, businessId: currentBusiness?.id, businessRequired: true });
    if (!currentOrg || !currentBusiness) {
      setPayrollRuns([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("payroll_runs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("pay_period_end", { ascending: false });

      if (error) throw error;
      setPayrollRuns((data || []) as unknown as PayrollRun[]);
    } catch (error) {
      console.error("Error fetching payroll runs:", error);
      toast.error("Failed to fetch payroll runs");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  const fetchPayslips = useCallback(async (payrollRunId: string) => {
    try {
      const { data, error } = await supabase
        .from("payslips")
        .select(`
          *,
          employee:employees(*)
        `)
        .eq("payroll_run_id", payrollRunId);

      if (error) throw error;
      setPayslips((data || []) as unknown as Payslip[]);
      return (data || []) as unknown as Payslip[];
    } catch (error) {
      console.error("Error fetching payslips:", error);
      toast.error("Failed to fetch payslips");
      return [];
    }
  }, []);

  useEffect(() => {
    fetchPayrollRuns();
  }, [fetchPayrollRuns]);

  const getNextPayrollNumber = async (): Promise<string> => {
    if (!currentOrg) return "PAY-0001";

    const { data, error } = await supabase.rpc("get_next_payroll_number", {
      _org_id: currentOrg.id,
    });

    if (error) {
      console.error("Error getting payroll number:", error);
      return `PAY-${Date.now()}`;
    }

    return data || "PAY-0001";
  };

  const createPayrollRun = async (
    payPeriodStart: string,
    payPeriodEnd: string,
    employees: Employee[],
    _statutoryConfig?: any,
    _ruleSet?: any,
    countryCode?: string | null,
    variableEarnings?: VariableEarningsInput[],
    paymentDate?: string,
    runOptions?: { run_type?: string; parent_run_id?: string | null },
    prorationOverrides?: Record<string, { full_period: boolean; reason: string }>,
  ) => {
    // SoD: creating/computing a run requires `runPayroll` (clerk capability).
    if (!can("runPayroll")) { toast.error("You don't have permission to create payroll runs"); throw new Error("Permission denied"); }
    if (!currentOrg || !user) throw new Error("No organization selected");

    // Call server-side Edge Function for computation
    const { data, error } = await supabase.functions.invoke("compute-payroll", {
      body: {
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        pay_period_start: payPeriodStart,
        pay_period_end: payPeriodEnd,
        payment_date: paymentDate || null,
        employee_ids: employees.map(e => e.id),
        country_code: countryCode ?? null,
        variable_earnings: variableEarnings || [],
        run_type: runOptions?.run_type ?? "regular",
        parent_run_id: runOptions?.parent_run_id ?? null,
        proration_overrides: prorationOverrides || {},
      },
    });

    if (error) {
      const { parseEdgeFunctionError } = await import("@/lib/edgeFunctionError");
      const parsed = await parseEdgeFunctionError(error);
      const err: any = new Error(parsed.message);
      err.code = parsed.code;
      err.status = parsed.status;
      err.payload = parsed.body;
      throw err;
    }

    if (data?.error) {
      const err: any = new Error(data.error);
      err.code = (data as any).code;
      err.payload = data;
      throw err;
    }

    // Show warnings if any (e.g., negative net pay adjustments)
    if (data?.warnings?.length > 0) {
      for (const w of data.warnings) {
        toast.warning(w);
      }
    }

    if (data?.reused) {
      toast.info(`Payroll ${data.payroll_run?.payroll_number || ""} already exists for this period`);
    } else {
      toast.success(`Payroll ${data.payroll_run?.payroll_number || ""} created with ${data.employee_count} employees`);
    }
    await fetchPayrollRuns();
    return data.payroll_run;
  };

  const approvePayrollRun = async (payrollRunId: string) => {
    // SoD: approval requires the dedicated `approvePayroll` permission.
    // The umbrella `managePayroll` is NOT accepted as a fallback — a single
    // role/group must explicitly grant approval rights (maker-checker).
    // The DB `approve_payroll_run` RPC + trigger additionally enforces the
    // self-approval policy (preparer ≠ approver).
    if (!can("approvePayroll")) {
      toast.error("You don't have permission to approve payroll");
      throw new Error("Permission denied");
    }
    if (!user) throw new Error("Not authenticated");

    const run = payrollRuns.find(r => r.id === payrollRunId);

    const { error } = await supabase.rpc("approve_payroll_run" as any, {
      p_run_id: payrollRunId,
    } as any);

    if (error) {
      const msg = String((error as any)?.message ?? "").toLowerCase();
      if (msg.includes("status approved") && msg.includes("cannot be approved")) {
        await fetchPayrollRuns();
        toast.info("Payroll was already approved");
        return;
      }
      throw error;
    }

    logAction({
      action: "approved",
      entityType: "payroll_run" as any,
      entityId: payrollRunId,
      entityName: run?.payroll_number || payrollRunId,
      changesSummary: `Approved payroll ${run?.payroll_number || payrollRunId}`,
    });

    toast.success("Payroll approved successfully");
    await fetchPayrollRuns();
  };

  /**
   * @deprecated Direct mark-paid was removed in Phase 5 (lifecycle integrity).
   *
   * Marking a payroll run paid MUST go through `payroll_payment_batches` +
   * the `post-payroll-payment-gl` edge function so the cash-side journal
   * entry (DR Net Salary Payable / CR Bank) is posted atomically. The
   * `payroll_runs_paid_path_guard` DB trigger now rejects any browser
   * UPDATE that flips status to 'paid'.
   *
   * Use `usePayrollPayments().createBatch` then `markBatchPaid` instead.
   */
  const processPayrollRun = async (_payrollRunId: string, _paymentDate: string) => {
    toast.error(
      "Direct 'mark paid' is disabled. Create a payment batch and post it through the payment lifecycle."
    );
    throw new Error("processPayrollRun is deprecated; use payment batch flow");
  };

  /**
   * Reverse a paid payroll run.
   * Creates a reversal payroll run with negated amounts and marks the original as reversed.
   */
  const reversePayrollRun = async (payrollRunId: string, reason: string, postToGL?: (run: PayrollRun, payslips: Payslip[]) => Promise<string | null>) => {
    // SoD: reversal posts a counter journal entry to the GL, so the actor
    // must hold `postPayrollGL` (the same permission that gated the original post).
    if (!can("postPayrollGL")) { toast.error("You don't have permission to reverse payroll"); throw new Error("Permission denied"); }
    if (!user || !currentOrg) throw new Error("Not authenticated");

    const run = payrollRuns.find(r => r.id === payrollRunId);
    if (!run) throw new Error("Payroll run not found");
    if (run.status !== "paid") {
      toast.error("Only paid payroll runs can be reversed");
      throw new Error("Invalid status for reversal");
    }

    // Delegate to server-side Edge Function for atomicity
    const { data, error } = await supabase.functions.invoke("reverse-payroll", {
      body: {
        payroll_run_id: payrollRunId,
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        reason,
        post_to_gl: !!postToGL,
      },
    });

    if (error) {
      const errorMsg = typeof error === "object" && error.message ? error.message : String(error);
      throw new Error(errorMsg);
    }

    if (data?.error) {
      throw new Error(data.error);
    }

    toast.success(`Payroll ${run.payroll_number} reversed. Reversal run: ${data.reversal_number}`);
    await fetchPayrollRuns();
    return data.reversal_run;
  };

  const deletePayrollRun = async (payrollRunId: string) => {
    // SoD: discard of a draft/approved run is a preparer-side action — `runPayroll`.
    if (!can("runPayroll")) { toast.error("You don't have permission to delete payroll runs"); throw new Error("Permission denied"); }
    // Guard: only draft or approved (not yet GL-posted / paid) runs can be deleted.
    // Once a run is posted to the GL or paid, it can only be REVERSED, never deleted.
    const run = payrollRuns.find(r => r.id === payrollRunId);
    const deletable = new Set(["draft", "approved"]);
    if (run && !deletable.has(run.status)) {
      toast.error(
        run.status === "posted" || run.status === "paid"
          ? `Cannot delete a ${run.status} payroll run — it has hit the General Ledger. Reverse it instead.`
          : `Cannot delete a ${run.status} payroll run.`
      );
      return;
    }

    const { error } = await supabase
      .from("payroll_runs")
      .delete()
      .eq("id", payrollRunId);

    if (error) throw error;

    logAction({
      action: "deleted",
      entityType: "payroll_run" as any,
      entityId: payrollRunId,
      entityName: run?.payroll_number || payrollRunId,
      oldValues: run ? { payroll_number: run.payroll_number, total_gross: run.total_gross, employee_count: run.employee_count } : undefined,
    changesSummary: `Deleted ${run?.status || "draft"} payroll ${run?.payroll_number || payrollRunId}`,
    });

    toast.success(`Payroll run ${run?.payroll_number || ""} deleted`.trim());
    await fetchPayrollRuns();
  };

  /**
   * Dry-run payroll preview — calls compute-payroll with dry_run=true.
   * Returns preview data without persisting anything.
   */
  const previewPayrollRun = async (
    payPeriodStart: string,
    payPeriodEnd: string,
    employees: Employee[],
    countryCode?: string | null,
    variableEarnings?: VariableEarningsInput[],
    runOptions?: { run_type?: string; parent_run_id?: string | null },
    prorationOverrides?: Record<string, { full_period: boolean; reason: string }>,
  ) => {
    if (!currentOrg) throw new Error("No organization selected");

    const { data, error } = await supabase.functions.invoke("compute-payroll", {
      body: {
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        pay_period_start: payPeriodStart,
        pay_period_end: payPeriodEnd,
        employee_ids: employees.map(e => e.id),
        country_code: countryCode ?? null,
        dry_run: true,
        variable_earnings: variableEarnings || [],
        run_type: runOptions?.run_type ?? "regular",
        parent_run_id: runOptions?.parent_run_id ?? null,
        proration_overrides: prorationOverrides || {},
      },
    });

    if (error) {
      const { parseEdgeFunctionError } = await import("@/lib/edgeFunctionError");
      const parsed = await parseEdgeFunctionError(error);
      const err: any = new Error(parsed.message);
      err.code = parsed.code;
      err.status = parsed.status;
      err.payload = parsed.body;
      throw err;
    }

    if (data?.error) {
      const err: any = new Error(data.error);
      err.code = (data as any).code;
      err.payload = data;
      throw err;
    }
    return data;
  };

  return {
    payrollRuns,
    payslips,
    isLoading,
    getNextPayrollNumber,
    createPayrollRun,
    previewPayrollRun,
    approvePayrollRun,
    processPayrollRun,
    reversePayrollRun,
    deletePayrollRun,
    fetchPayslips,
    refreshPayrollRuns: fetchPayrollRuns,
  };
}
