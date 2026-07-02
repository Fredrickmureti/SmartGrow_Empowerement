/**
 * Employee Year-To-Date payroll ledger.
 *
 * Reads the `payroll_employee_ytd` table (maintained by trigger on
 * payslip_lines) via the `payroll_employee_ytd_rollup(year, employee_id)`
 * RPC. This is the single source of truth that tax certificates and
 * annual statutory returns must reconcile to — never aggregate
 * payslip_lines client-side for those purposes.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface EmployeeYtdRow {
  rule_code: string;
  category: string | null;
  country_code: string | null;
  employee_amount: number;
  employer_amount: number;
  taxable_amount: number;
  payslip_count: number;
  last_period_end: string | null;
}

/** Per-employee per-year rollup, suitable for tax-certificate generation. */
export function useEmployeeYtdRollup(employeeId?: string, fiscalYear?: number) {
  return useQuery({
    queryKey: ["payroll-employee-ytd-rollup", employeeId, fiscalYear],
    enabled: !!employeeId && !!fiscalYear,
    queryFn: async (): Promise<EmployeeYtdRow[]> => {
      const { data, error } = await supabase.rpc(
        "payroll_employee_ytd_rollup" as any,
        { p_year: fiscalYear, p_employee_id: employeeId },
      );
      if (error) throw error;
      return (data ?? []) as EmployeeYtdRow[];
    },
  });
}

/** Year-wide list across employees in the current business (for grids/exports). */
export function useEmployeeYtdYear(fiscalYear?: number) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["payroll-employee-ytd-year", currentOrg?.id, currentBusiness?.id, fiscalYear],
    enabled: !!currentOrg?.id && !!currentBusiness?.id && !!fiscalYear,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_employee_ytd" as any)
        .select("*")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .eq("fiscal_year", fiscalYear!)
        .order("employee_id");
      if (error) throw error;
      return data ?? [];
    },
  });
}