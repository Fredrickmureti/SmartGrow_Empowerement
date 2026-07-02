/**
 * useEmployeePayrollReadiness — structured per-(employee × rule) status
 * for the Payroll Readiness page.
 *
 * Backed by `payroll_readiness_employee_matrix(...)`. The hook never
 * regex-matches on rule codes and never derives ready-state on the
 * client — that comes from the engine.
 *
 * The single-employee variant `useEmployeeReadiness(id)` is a thin
 * projection over the same RPC so the profile badge and the readiness
 * page share state.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export type ReadinessRuleStatus = "pass" | "fail" | "warn" | "na";
export type ReadinessSeverity = "block" | "warn";

export interface ReadinessRuleMeta {
  code: string;
  name: string;
  description: string | null;
  severity: ReadinessSeverity | string;
  reason_code: string | null;
  remediation_label: string | null;
  remediation_link: string | null;
  sort_order: number | null;
  prerequisite_rule_codes: string[] | null;
}

export interface ReadinessFinding {
  rule_code: string;
  rule_name: string;
  severity: ReadinessSeverity | string;
  status: ReadinessRuleStatus | string;
  reason: string | null;
  reason_code: string | null;
  missing_fields: string[] | null;
  remediation_label: string | null;
  remediation_link: string | null;
  details: Record<string, unknown> | null;
}

export interface EmployeeReadinessRow {
  employee_id: string;
  first_name: string | null;
  last_name: string | null;
  employee_number: string | null;
  rule_status: Record<string, ReadinessRuleStatus>;
  findings: ReadinessFinding[];
  blockers_count: number;
  warnings_count: number;
  na_count: number;
  pass_count: number;
  is_ready: boolean;
}

export interface EmployeeReadinessMatrix {
  rules: ReadinessRuleMeta[];
  employees: EmployeeReadinessRow[];
  period_start: string | null;
  period_end: string | null;
  evaluated_at: string;
}

export interface UseEmployeePayrollReadinessOptions {
  periodStart?: string | null;
  periodEnd?: string | null;
  employeeIds?: string[] | null;
  enabled?: boolean;
}

export function useEmployeePayrollReadiness(
  opts: UseEmployeePayrollReadinessOptions = {},
) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;
  const periodStart = opts.periodStart ?? null;
  const periodEnd = opts.periodEnd ?? null;
  const employeeIds = opts.employeeIds ?? null;

  const empKey = useMemo(
    () =>
      employeeIds && employeeIds.length
        ? [...employeeIds].sort().join(",")
        : null,
    [employeeIds],
  );

  return useQuery({
    queryKey: [
      "payroll-readiness-matrix",
      orgId,
      businessId,
      periodStart,
      periodEnd,
      empKey,
    ],
    enabled: opts.enabled !== false && !!orgId,
    staleTime: 15_000,
    queryFn: async (): Promise<EmployeeReadinessMatrix> => {
      const { data, error } = await (supabase as any).rpc(
        "payroll_readiness_employee_matrix",
        {
          p_org_id: orgId,
          p_business_id: businessId,
          p_employee_ids: employeeIds,
          p_period_start: periodStart,
          p_period_end: periodEnd,
        },
      );
      if (error) throw error;
      return (data ?? {
        rules: [],
        employees: [],
        period_start: periodStart,
        period_end: periodEnd,
        evaluated_at: new Date().toISOString(),
      }) as EmployeeReadinessMatrix;
    },
  });
}

/** Single-employee variant — used on profile pages. */
export function useEmployeeReadiness(employeeId: string | null | undefined) {
  const query = useEmployeePayrollReadiness({
    employeeIds: employeeId ? [employeeId] : null,
    enabled: !!employeeId,
  });
  const row = query.data?.employees?.[0] ?? null;
  return {
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    data: !employeeId
      ? null
      : {
          employee_id: employeeId,
          is_ready: row?.is_ready ?? false,
          findings: row?.findings ?? [],
          rule_status: row?.rule_status ?? {},
        },
  };
}

/** List of employees in scope for a payroll period. */
export function usePayrollPeriodEmployees(opts: {
  periodStart?: string | null;
  periodEnd?: string | null;
  enabled?: boolean;
} = {}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;
  return useQuery({
    queryKey: [
      "payroll-period-employees",
      orgId,
      businessId,
      opts.periodStart ?? null,
      opts.periodEnd ?? null,
    ],
    enabled: opts.enabled !== false && !!orgId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc(
        "payroll_period_employees",
        {
          p_org_id: orgId,
          p_business_id: businessId,
          p_period_start: opts.periodStart ?? null,
          p_period_end: opts.periodEnd ?? null,
        },
      );
      if (error) throw error;
      return (data ?? []) as Array<{
        employee_id: string;
        first_name: string | null;
        last_name: string | null;
        employee_number: string | null;
      }>;
    },
  });
}
