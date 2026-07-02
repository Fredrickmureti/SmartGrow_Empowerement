/**
 * Payroll Statutory Rules — Data-fetching hook.
 * 
 * Fetches DB-driven payroll rules for a given country and organization.
 * 
 * ⚠️  This hook is for DATA RETRIEVAL and DISPLAY only. All payroll
 * computations happen server-side in the `compute-payroll` Edge Function.
 * Use `dry_run=true` for payroll previews — never compute client-side.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";

// ─── Types ───────────────────────────────────────────────────────────────

export interface PayrollRule {
  id: string;
  rule_type: string;
  rule_name: string;
  parameters: Record<string, any>;
  sort_order: number;
}

/** A single computed deduction from a payroll rule */
export interface PayrollDeduction {
  rule_type: string;
  label: string;
  employee_amount: number;
  employer_amount: number;
}

/** Grouped rules by type, ready for display */
export interface PayrollRuleSet {
  rulesByType: Record<string, PayrollRule[]>;
  personalRelief: number;
  maxExemptHousing: number;
  isLoaded: boolean;
}

const EMPTY_RULE_SET: PayrollRuleSet = {
  rulesByType: {},
  personalRelief: 0,
  maxExemptHousing: 0,
  isLoaded: false,
};

// ─── Rule Parsing ────────────────────────────────────────────────────────

function parseRulesToRuleSet(rules: PayrollRule[]): PayrollRuleSet {
  const rulesByType: Record<string, PayrollRule[]> = {};
  let personalRelief = 0;
  let maxExemptHousing = 0;

  for (const rule of rules) {
    if (!rulesByType[rule.rule_type]) {
      rulesByType[rule.rule_type] = [];
    }
    rulesByType[rule.rule_type].push(rule);

    if (rule.rule_type === "personal_relief") {
      personalRelief = rule.parameters.amount ?? 0;
    }
    if (rule.rule_type === "housing_exemption") {
      maxExemptHousing = rule.parameters.max_amount ?? 0;
    }
  }

  return { rulesByType, personalRelief, maxExemptHousing, isLoaded: true };
}


// ─── Hook ────────────────────────────────────────────────────────────────

export function usePayrollStatutoryRules(countryCode?: string) {
  const { currentOrg } = useOrganization();

  const { data: ruleSet, isLoading } = useQuery({
    queryKey: ["payroll-statutory-rules", currentOrg?.id, countryCode],
    queryFn: async () => {
      if (!currentOrg?.id) return EMPTY_RULE_SET;
      if (!countryCode) {
        return { ...EMPTY_RULE_SET, isLoaded: true };
      }

      const today = new Date().toISOString().split("T")[0];

      const { data, error } = await supabase
        .from("payroll_statutory_rules" as any)
        .select("id, rule_type, rule_name, parameters, sort_order")
        .eq("organization_id", currentOrg.id)
        .eq("country_code", countryCode)
        .eq("is_active", true)
        .lte("effective_from", today)
        .or(`effective_to.is.null,effective_to.gte.${today}`)
        .order("sort_order", { ascending: true });

      if (error) {
        console.error("Failed to fetch payroll rules, using empty config:", error);
        return { ...EMPTY_RULE_SET, isLoaded: true };
      }

      if (!data || data.length === 0) {
        console.warn("No payroll statutory rules configured for this organization. Payroll deductions will be zero. Please configure rules in HR > Payroll Statutory Rules.");
        return { ...EMPTY_RULE_SET, isLoaded: true };
      }

      return parseRulesToRuleSet(data as unknown as PayrollRule[]);
    },
    enabled: !!currentOrg?.id,
    staleTime: 10 * 60 * 1000,
  });

  const currentRuleSet = ruleSet ?? EMPTY_RULE_SET;

  return {
    ruleSet: currentRuleSet,
    personalRelief: currentRuleSet.personalRelief,
    maxExemptHousing: currentRuleSet.maxExemptHousing,
    isLoading,
  };
}
