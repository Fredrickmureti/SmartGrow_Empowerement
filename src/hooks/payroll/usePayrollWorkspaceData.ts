/**
 * Read-only React Query hooks for the new Payroll workspace pages.
 *
 * These wrap tables that already exist server-side but had no UI surface
 * before Stage 3 of the Payroll overhaul:
 *
 *   - payroll_work_entries        attendance/leave hours rolled up per run
 *   - payroll_run_issues          preflight blockers/warnings emitted by
 *                                 validate_payroll_run_inputs(_run_id)
 *   - payslip_lines               line-by-line breakdown (the only place
 *                                 generic country-agnostic deductions /
 *                                 employer contributions live since Stage 2)
 *   - payroll_payment_batches     payroll payment batches + items
 *
 * All queries are scoped by org + business via the standard
 * useOrganization / useBusinesses hooks. RLS still enforces this server-side.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface PayrollWorkEntry {
  id: string;
  payroll_run_id: string;
  employee_id: string;
  organization_id: string;
  business_id: string | null;
  hours: number;
  overtime_hours: number;
  attendance_count: number;
  source: string;
  work_date_start: string;
  work_date_end: string;
}

export function usePayrollWorkEntries(payrollRunId?: string) {
  return useQuery({
    queryKey: ["payroll-work-entries", payrollRunId],
    enabled: !!payrollRunId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_work_entries")
        .select("*")
        .eq("payroll_run_id", payrollRunId!)
        .order("work_date_start", { ascending: true });
      if (error) throw error;
      return (data ?? []) as PayrollWorkEntry[];
    },
  });
}

export type PayrollRunIssueSeverity = "blocker" | "warning" | "info";

export interface PayrollRunIssue {
  id: string;
  payroll_run_id: string;
  employee_id: string | null;
  code: string;
  severity: PayrollRunIssueSeverity;
  message: string;
  details: unknown;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

export function usePayrollRunIssues(payrollRunId?: string) {
  return useQuery({
    queryKey: ["payroll-run-issues", payrollRunId],
    enabled: !!payrollRunId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_run_issues")
        .select("*")
        .eq("payroll_run_id", payrollRunId!)
        .order("severity", { ascending: true })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PayrollRunIssue[];
    },
  });
}

export interface PayslipLine {
  id: string;
  payslip_id: string;
  payroll_run_id: string | null;
  employee_id: string | null;
  rule_code: string;
  rule_type: string | null;
  category: string;
  label: string;
  employee_amount: number;
  employer_amount: number;
  taxable: boolean;
  sequence: number;
  /** Engine-authored explanation payload (jsonb). Null on legacy rows. */
  source?: any;
  /** FK to `payroll_statutory_rules.id` for the rule version that produced this line. */
  rule_version_id?: string | null;
  /** Hash of the rule version's parameters at compute time (drift detection). */
  rule_version_hash?: string | null;
}

export function usePayslipLines(payslipId?: string) {
  return useQuery({
    queryKey: ["payslip-lines", payslipId],
    enabled: !!payslipId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payslip_lines")
        .select("*")
        .eq("payslip_id", payslipId!)
        .order("sequence", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as PayslipLine[];
    },
  });
}

export interface PayrollPaymentBatch {
  id: string;
  batch_number: string;
  payroll_run_id: string;
  status: string;
  total_amount: number;
  payment_date: string | null;
  bank_account_id: string | null;
  reference: string | null;
  confirmed_at: string | null;
  created_at: string;
}

export function usePayrollPaymentBatches() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["payroll-payment-batches", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_payment_batches")
        .select("*")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PayrollPaymentBatch[];
    },
  });
}

/**
 * Cross-payroll payslip search — list payslips across all runs for the
 * current business. Used by /hr/payroll/payslips.
 */
export function useAllPayslips() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["all-payslips", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payslips")
        .select("*, employee:employees(id, employee_number, first_name, last_name)")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });
}
