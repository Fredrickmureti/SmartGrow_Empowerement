import { normalizeError } from "@/services/resilience";
/**
 * Stage D — salary rule graph CRUD hook (`payroll_salary_rules`).
 *
 * Replaces the flat `salary_components` model with an Odoo-parity ordered
 * rule graph. Rows are scoped to a structure; the structure engine reads
 * them via `salary_structure_rule_sets.components` snapshot at compute time.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export type RuleCategory = "basic" | "allowance" | "deduction" | "employer_contribution" | "net" | "gross" | "other";
export type ConditionMode = "always" | "expression";
export type AmountMode = "fixed" | "percentage" | "expression" | "statutory_ref";

export interface SalaryRule {
  id: string;
  organization_id: string;
  business_id: string | null;
  structure_id: string;
  code: string;
  name: string;
  sequence: number;
  category: RuleCategory;
  parent_rule_id: string | null;
  condition_select: ConditionMode;
  condition_expression: string | null;
  amount_select: AmountMode;
  amount_fixed: number | null;
  amount_percentage: number | null;
  amount_base: string | null;
  amount_expression: string | null;
  statutory_rule_id: string | null;
  appears_on_payslip: boolean;
  accounting_debit_account_id: string | null;
  accounting_credit_account_id: string | null;
  accounting_tag: string | null;
  is_active: boolean;
}

export type SalaryRuleInput = Omit<SalaryRule, "id" | "organization_id" | "business_id" | "structure_id"> & {
  id?: string;
};

export function useSalaryRules(structureId: string | undefined) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["payroll-salary-rules", structureId],
    enabled: !!structureId && !!currentOrg?.id,
    queryFn: async (): Promise<SalaryRule[]> => {
      const { data, error } = await supabase
        .from("payroll_salary_rules" as any)
        .select("*")
        .eq("structure_id", structureId!)
        .order("sequence", { ascending: true });
      if (error) throw error;
      return (data || []) as unknown as SalaryRule[];
    },
  });

  const upsert = useMutation({
    mutationFn: async (input: SalaryRuleInput) => {
      if (!currentOrg?.id || !structureId) throw new Error("Missing org/structure");
      if (!currentBusiness?.id) throw new Error("Select a company first");
      const payload: any = {
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        structure_id: structureId,
        code: input.code.trim(),
        name: input.name.trim(),
        sequence: input.sequence,
        category: input.category,
        parent_rule_id: input.parent_rule_id || null,
        condition_select: input.condition_select,
        condition_expression: input.condition_expression || null,
        amount_select: input.amount_select,
        amount_fixed: input.amount_fixed,
        amount_percentage: input.amount_percentage,
        amount_base: input.amount_base || null,
        amount_expression: input.amount_expression || null,
        statutory_rule_id: input.statutory_rule_id || null,
        appears_on_payslip: input.appears_on_payslip,
        accounting_debit_account_id: input.accounting_debit_account_id || null,
        accounting_credit_account_id: input.accounting_credit_account_id || null,
        accounting_tag: input.accounting_tag || null,
        is_active: input.is_active,
      };
      if (input.id) {
        const { error } = await supabase
          .from("payroll_salary_rules" as any)
          .update(payload)
          .eq("id", input.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("payroll_salary_rules" as any)
          .insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-salary-rules", structureId] });
      toast.success("Rule saved");
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Save failed"),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("payroll_salary_rules" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-salary-rules", structureId] });
      toast.success("Rule deleted");
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Delete failed"),
  });

  return { rules, isLoading, upsert, remove };
}
