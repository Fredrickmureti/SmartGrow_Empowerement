/**
 * usePayrollRuleTypes
 * ─────────────────────────────────────────────────────────────────────────
 * Shared React-Query hook + types for *tenant-defined* custom deduction
 * types (`payroll_rule_types`).
 *
 * These are NOT statutory rules. Statutory rules are pack-driven and live in
 * `payroll_statutory_rules`. Custom deduction types are workspace-owned
 * shapes (loans, advances, SACCO contributions, gym fees) with their own
 * lifecycle and their own dedicated workspace
 * (`/hr/payroll/configuration/deduction-types`). They are co-located here
 * only because the statutory rule editor surfaces their codes in its
 * type-picker so existing rules round-trip cleanly.
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

export interface RuleType {
  id: string;
  organization_id: string;
  code: string;
  label: string;
  description: string | null;
  parameter_schema: ParameterField[];
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
        // SCOPE-EXEMPT: "payroll_rule_types" is workspace-wide (not in BUSINESS_SCOPED_TABLES)
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
