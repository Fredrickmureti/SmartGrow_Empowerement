/**
 * Write-side companion to `useVariableInputTypes`.
 *
 * `payroll_input_types` is the country-agnostic registry of per-run
 * variable input slots (Odoo `hr.payslip.input.type`, SAP wage-type
 * permissibility, Workday pay-component inputs). Until now the table
 * could only be seeded with raw SQL, so the payroll-create grid was a
 * dead end for tenants. These mutations give payroll admins a
 * self-service authoring surface.
 *
 * No country defaults are implied: the starter set below uses only the
 * variable-earning keys the engine already reads via `ctx.inputs`
 * (ADR 0010 Gap #2), so a seeded slot flows into the run and is taxed
 * through the normal PAYE path.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import type { PayrollInputType, PayrollInputUnit } from "./useVariableInputTypes";

export interface PayrollInputTypeDraft {
  id?: string;
  business_id: string | null;
  code: string;
  name: string;
  description: string | null;
  input_unit: PayrollInputUnit;
  default_value: number | null;
  min_value: number | null;
  max_value: number | null;
  is_required: boolean;
  structure_ids: string[];
  is_active: boolean;
  sequence: number;
}

/** Engine-recognised starter slots. Codes match the variable-earning keys
 *  `compute-payroll` surfaces through `ctx.inputs`. */
export const STARTER_INPUT_TYPES: Array<
  Pick<PayrollInputTypeDraft, "code" | "name" | "input_unit" | "description" | "sequence">
> = [
  { code: "overtime_amount", name: "Overtime", input_unit: "amount", description: "Overtime pay entered as a cash amount for the run.", sequence: 10 },
  { code: "overtime_hours", name: "Overtime hours", input_unit: "hours", description: "Overtime measured in hours; priced by the applicable rule.", sequence: 20 },
  { code: "bonus_amount", name: "Bonus", input_unit: "amount", description: "One-off bonus paid in this run.", sequence: 30 },
  { code: "commission_amount", name: "Commission", input_unit: "amount", description: "Commission earned in this period.", sequence: 40 },
  { code: "arrears_amount", name: "Arrears / back pay", input_unit: "amount", description: "Retrospective pay owed from earlier periods.", sequence: 50 },
];

export const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Returns a human-readable problem, or null when the draft is valid. */
export function validateInputTypeDraft(
  d: PayrollInputTypeDraft,
  existing: PayrollInputType[],
): string | null {
  if (!d.name.trim()) return "Name is required.";
  if (!CODE_PATTERN.test(d.code)) {
    return "Code must be lowercase letters, digits and underscores, starting with a letter (e.g. overtime_amount).";
  }
  const clash = existing.find(
    (r) => r.code === d.code && r.business_id === d.business_id && r.id !== d.id,
  );
  if (clash) return `Code "${d.code}" already exists in this scope.`;
  const { min_value: min, max_value: max, default_value: def } = d;
  if (min != null && max != null && min > max) return "Minimum cannot be greater than maximum.";
  if (def != null && min != null && def < min) return "Default cannot be below the minimum.";
  if (def != null && max != null && def > max) return "Default cannot be above the maximum.";
  return null;
}

export function useVariableInputTypeMutations() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["payroll-input-types"] });
  };

  const upsert = useMutation({
    mutationFn: async (draft: PayrollInputTypeDraft) => {
      if (!currentOrg?.id) throw new Error("No organization selected");
      const row = {
        organization_id: currentOrg.id,
        business_id: draft.business_id,
        code: draft.code.trim(),
        name: draft.name.trim(),
        description: draft.description?.trim() || null,
        input_unit: draft.input_unit,
        default_value: draft.default_value,
        min_value: draft.min_value,
        max_value: draft.max_value,
        is_required: draft.is_required,
        structure_ids: draft.structure_ids,
        is_active: draft.is_active,
        sequence: draft.sequence,
      };
      const q = draft.id
        ? supabase.from("payroll_input_types" as any).update(row).eq("id", draft.id)
        : supabase.from("payroll_input_types" as any).insert(row);
      const { error } = await q;
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Variable input saved");
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const setActive = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from("payroll_input_types" as any)
        .update({ is_active })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("payroll_input_types" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Variable input deleted");
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const seedStarterSet = useMutation({
    mutationFn: async (opts?: { businessScoped?: boolean }) => {
      if (!currentOrg?.id) throw new Error("No organization selected");
      const businessId = opts?.businessScoped ? currentBusiness?.id ?? null : null;
      const rows = STARTER_INPUT_TYPES.map((t) => ({
        organization_id: currentOrg.id,
        business_id: businessId,
        code: t.code,
        name: t.name,
        description: t.description,
        input_unit: t.input_unit,
        default_value: null,
        min_value: null,
        max_value: null,
        is_required: false,
        structure_ids: [] as string[],
        is_active: true,
        sequence: t.sequence,
      }));
      const { error } = await supabase.from("payroll_input_types" as any).insert(rows);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Standard variable inputs added");
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  return { upsert, setActive, remove, seedStarterSet };
}
