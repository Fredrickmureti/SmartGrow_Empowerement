/**
 * usePayrollReportReadiness — lifecycle-dependency probe for a report.
 *
 * Calls the `payroll_report_readiness(p_organization_id, p_business_id,
 * p_report_key, p_date_from, p_date_to)` SECURITY DEFINER function
 * introduced in Phase 5a. Returns a map of dependency → state so the
 * library card / viewer header can render a "Waiting: GL not posted"
 * chip instead of silently showing empty results.
 *
 * The function returns `{}` for definitions that declare no
 * dependencies, so consumers can render nothing without special-casing.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { PayrollReportDependency } from "./usePayrollReportDefinitions";

export type PayrollReportDependencyState = "ready" | "pending" | "unknown";

export type PayrollReportReadiness = Partial<
  Record<PayrollReportDependency, PayrollReportDependencyState>
>;

export const DEPENDENCY_LABEL: Record<PayrollReportDependency, string> = {
  payroll_approved: "Payroll approved",
  gl_posted: "GL posted",
  remittance_filed: "Remittance filed",
};

export function usePayrollReportReadiness(params: {
  organizationId?: string | null;
  businessId?: string | null;
  reportKey?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  dependencies?: PayrollReportDependency[];
  enabled?: boolean;
}) {
  const {
    organizationId,
    businessId,
    reportKey,
    dateFrom,
    dateTo,
    dependencies,
    enabled = true,
  } = params;

  return useQuery({
    queryKey: [
      "payroll-report-readiness",
      organizationId ?? null,
      businessId ?? null,
      reportKey ?? null,
      dateFrom ?? null,
      dateTo ?? null,
    ],
    enabled:
      enabled &&
      !!organizationId &&
      !!reportKey &&
      !!dateFrom &&
      !!dateTo &&
      (dependencies?.length ?? 0) > 0,
    queryFn: async (): Promise<PayrollReportReadiness> => {
      const { data, error } = await (supabase as any).rpc(
        "payroll_report_readiness",
        {
          p_organization_id: organizationId,
          p_business_id: businessId ?? null,
          p_report_key: reportKey,
          p_date_from: dateFrom,
          p_date_to: dateTo,
        },
      );
      if (error) throw error;
      return (data ?? {}) as PayrollReportReadiness;
    },
  });
}
