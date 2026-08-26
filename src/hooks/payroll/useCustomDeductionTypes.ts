/**
 * useCustomDeductionTypes — Slice 2 catalog hook.
 *
 * Backs the workspace-defined ad-hoc deduction catalog
 * (`public.custom_deduction_types`). This is NOT loans, advances,
 * garnishments, or statutory items — each of those has a first-class
 * subsystem. See `docs/adr/0040-*` and the audit at `.lovable/plan.md`
 * for the full trace.
 *
 * Business-scoped; RLS enforces that only members of the business can
 * read/write. Soft-delete via `is_active = false` (never hard delete —
 * historical assignments FK-reference the row).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type CustomDeductionKind = "recurring" | "one_time" | "voluntary" | "involuntary";
export type CustomDeductionTaxTreatment = "pre_tax" | "post_tax";
export type CustomDeductionComputationMethod =
  | "flat_amount"
  | "percentage_of_gross"
  | "percentage_of_basic"
  | "formula";

export interface CustomDeductionType {
  id: string;
  business_id: string;
  code: string;
  label: string;
  description: string | null;
  deduction_kind: CustomDeductionKind;
  tax_treatment: CustomDeductionTaxTreatment;
  is_taxable: boolean;
  is_employer_contribution: boolean;
  computation_method: CustomDeductionComputationMethod;
  parameters: Record<string, unknown>;
  gl_liability_account_id: string | null;
  gl_expense_account_id: string | null;
  payslip_group: string;
  sort_order: number;
  requires_approval: boolean;
  is_active: boolean;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Optional pack-declared rule code emitted on payslip_lines. When
   * set, compute-payroll uses this string verbatim as the rule_code
   * so localization pack return templates and pack tokens can bind
   * to it (e.g. Kenya NSSF Type-105 "nssf_voluntary" → NSSF_RET
   * VOLUNTARY column). Legacy rows leave it null and get the
   * `custom_<code>` fallback.
   */
  payroll_rule_code: string | null;
  /**
   * Optional binding to a localization-pack `statutory_scheme_components`
   * row. Set together with `payroll_rule_code` when this deduction represents
   * a pack-published scheme component (e.g. Kenya HELB, NSSF Type-105). It is
   * what makes the deduction remittable to the scheme's external authority
   * and eligible for that scheme's statutory return.
   */
  scheme_component_id: string | null;
}

export type CustomDeductionTypeInput = Omit<
  CustomDeductionType,
  "id" | "business_id" | "version" | "created_by" | "created_at" | "updated_at"
>;

const KEY = "custom-deduction-types";

export function useCustomDeductionTypes(opts?: { includeInactive?: boolean }) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const includeInactive = opts?.includeInactive ?? false;

  return useQuery({
    queryKey: [KEY, businessId, includeInactive],
    enabled: !!businessId,
    queryFn: async () => {
      let q = supabase
        .from("custom_deduction_types")
        .select("*")
        .eq("business_id", businessId!)
        .order("sort_order", { ascending: true })
        .order("label", { ascending: true });
      if (!includeInactive) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as CustomDeductionType[];
    },
  });
}

export function useCustomDeductionTypeMutations() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const invalidate = () => qc.invalidateQueries({ queryKey: [KEY] });

  const create = useMutation({
    mutationFn: async (input: CustomDeductionTypeInput) => {
      if (!businessId) throw new Error("No business selected");
      const { data, error } = await supabase
        .from("custom_deduction_types")
        .insert({ ...input, business_id: businessId } as never)
        .select()
        .single();
      if (error) throw error;
      return data as unknown as CustomDeductionType;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Custom deduction type created");
    },
    onError: (err) => toast.error(normalizeError(err).message),
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<CustomDeductionTypeInput> }) => {
      const { data, error } = await supabase
        .from("custom_deduction_types")
        .update(patch as never)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as unknown as CustomDeductionType;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Custom deduction type updated");
    },
    onError: (err) => toast.error(normalizeError(err).message),
  });

  /** Soft-delete: flip is_active to false. Never hard delete — FKs from
   *  employee_custom_deductions must resolve. */
  const archive = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("custom_deduction_types")
        .update({ is_active: false } as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Archived");
    },
    onError: (err) => toast.error(normalizeError(err).message),
  });

  return { create, update, archive };
}
