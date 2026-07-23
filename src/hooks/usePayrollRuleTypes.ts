/**
 * usePayrollRuleTypes
 * ─────────────────────────────────────────────────────────────────────────
 * Shared React-Query hook + types for tenant-defined **Rule Type
 * Definitions** (`payroll_rule_types`).
 *
 * IMPORTANT — What this table is (and isn't):
 *   - It is a *catalog of (label, parameter_schema, computation_method)
 *     tuples* consumed exclusively by the Statutory Rules editor to
 *     populate its type-picker and render parameter form fields.
 *   - It is NOT a deduction. No consumer creates an employee deduction,
 *     payslip line, or GL entry from these rows. Actual deduction
 *     lifecycles live in `employee_loans`, `employee_advances`,
 *     `legal_orders_records`, and `payroll_salary_rules`.
 *
 * Tenant-authored rows live alongside pack-seeded system rows (is_system
 * = true) so historical `payroll_statutory_rules.rule_type` values keep
 * resolving to a human label. The workspace surface is
 * `/hr/payroll/configuration/rule-types`.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ParameterField {
  key: string;
  label: string;
  type: string;
  placeholder?: string;
  step?: string;
  optional?: boolean;
}

export type RuleTypeComputationMethod =
  | "flat_amount"
  | "percentage_of_gross"
  | "bracket_progressive"
  | "tiered_brackets"
  | "graduated_table"
  | "per_employee_flat";

export interface RuleType {
  id: string;
  organization_id: string;
  code: string;
  label: string;
  description: string | null;
  parameter_schema: ParameterField[];
  computation_method: RuleTypeComputationMethod;
  is_bracket: boolean;
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
}

export function useRuleTypes(orgId: string | undefined) {
  return useQuery({
    queryKey: ["payroll-rule-types", orgId],
    queryFn: async () => {
      if (!orgId) return [] as RuleType[];
      const { data, error } = await supabase
        // SCOPE-EXEMPT: `payroll_rule_types` is a workspace-level catalog
        // (same shape as `leave_types`) — no business_id column.
        .from("payroll_rule_types" as any)
        .select("*")
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as RuleType[];
    },
    enabled: !!orgId,
  });
}
