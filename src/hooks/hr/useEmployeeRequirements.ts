/**
 * useEmployeeRequirements — pack-driven source of truth.
 *
 * Single hook the Employee form, Statutory configuration page, and
 * Payroll readiness engine all consult to learn "what does this
 * business actually require?".
 *
 * Backed by the `pack_required_employee_fields(business_id, module)`
 * RPC, which merges `pack_requirements` rows: tenant overrides win
 * over pack-published defaults on the same
 * (scope, requirement_key, country_code).
 *
 * Returning [] means the business has no installed pack for that
 * module — the UI must render an "install a pack" empty state, NOT
 * fall back to a hardcoded list. The previous architecture had two
 * disconnected hooks each with their own hardcoded global catalog;
 * this hook replaces both of them.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";

export type RequirementScope =
  | "employee_field"
  | "statutory_identifier"
  | "payroll_rule"
  | "account_mapping"
  | "onboarding_item";

export type RequirementModule =
  | "core"
  | "payroll"
  | "attendance"
  | "timesheets"
  | "benefits"
  | "hr";

export interface EmployeeRequirement {
  requirement_key: string;
  scope: RequirementScope;
  module: RequirementModule;
  country_code: string | null;
  label: string;
  help_text: string | null;
  validation_regex: string | null;
  data_type: string;
  is_required: boolean;
  blocks_onboarding: boolean;
  blocks_payroll: boolean;
  sort_order: number;
  pack_id: string | null;
  source: "pack" | "tenant_override";
  has_override: boolean;
}

export function useEmployeeRequirements(opts?: { module?: RequirementModule }) {
  const { currentBusiness } = useBusinesses();
  const moduleFilter = opts?.module ?? null;

  const query = useQuery({
    queryKey: ["pack-required-employee-fields", currentBusiness?.id, moduleFilter],
    enabled: !!currentBusiness?.id,
    queryFn: async (): Promise<EmployeeRequirement[]> => {
      const { data, error } = await (supabase as any).rpc(
        "pack_required_employee_fields",
        { p_business_id: currentBusiness!.id, p_module: moduleFilter },
      );
      if (error) throw error;
      return (data ?? []) as EmployeeRequirement[];
    },
  });

  const all = query.data ?? [];
  return {
    isLoading: query.isLoading,
    error: query.error,
    all,
    statutory: all.filter((r) => r.scope === "statutory_identifier"),
    onboarding: all.filter((r) => r.scope === "onboarding_item"),
    payrollRules: all.filter((r) => r.scope === "payroll_rule"),
    accountMappings: all.filter((r) => r.scope === "account_mapping"),
    refetch: query.refetch,
  };
}
