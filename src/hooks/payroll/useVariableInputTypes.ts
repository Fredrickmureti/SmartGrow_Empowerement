/**
 * Phase 4 P1.2e — pack-declared variable payroll input registry.
 *
 * Reads `public.payroll_input_types` (the country-agnostic equivalent
 * of Odoo `hr.payslip.input.type`, SAP wage-type permissibility, and
 * Workday pay-component input templates).
 *
 * Each row is a per-run input slot the localization pack has declared:
 * a `code` (the rule_code the engine looks up), a human label, a unit
 * (`amount` / `hours` / `days` / `count`), and optional validation
 * metadata. The payroll-create UI renders one column per row that
 * applies in scope.
 *
 * Scope resolution (mirrors Odoo `struct_ids` semantics):
 *   1. org+business scoped rows take precedence over org-only rows
 *      sharing the same `code` (business override);
 *   2. `structure_ids = []`  → applies to all structures in scope;
 *   3. `structure_ids = [..]` → applies only to those structures
 *      (caller passes the active structure id to filter).
 *
 * Empty result → no fallback to hardcoded country defaults. The UI
 * must show an explicit "install / configure a pack" notice.
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQuery } from "@tanstack/react-query";

export type PayrollInputUnit = "amount" | "hours" | "days" | "count";

export interface PayrollInputType {
  id: string;
  organization_id: string;
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

export function useVariableInputTypes(structureId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: [
      "payroll-input-types",
      currentOrg?.id,
      currentBusiness?.id,
      structureId ?? null,
    ],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<PayrollInputType[]> => {
      let q = supabase
        .from("payroll_input_types" as any)
        .select(
          "id, organization_id, business_id, code, name, description, input_unit, default_value, min_value, max_value, is_required, structure_ids, is_active, sequence",
        )
        .eq("organization_id", currentOrg!.id)
        .eq("is_active", true)
        .order("sequence", { ascending: true });

      if (currentBusiness?.id) {
        q = q.or(`business_id.eq.${currentBusiness.id},business_id.is.null`);
      } else {
        q = q.is("business_id", null);
      }

      const { data, error } = await q;
      if (error) throw error;

      const rows = (data || []) as unknown as PayrollInputType[];

      // Apply structure-id filter (empty array = all structures).
      const structureFiltered = structureId
        ? rows.filter(
            (r) => r.structure_ids.length === 0 || r.structure_ids.includes(structureId),
          )
        : rows;

      // Business-scope precedence: when org and business rows share a
      // `code`, the business row wins. The original `order by sequence`
      // is preserved within each `code` group.
      const byCode = new Map<string, PayrollInputType>();
      for (const r of structureFiltered) {
        const existing = byCode.get(r.code);
        if (!existing) {
          byCode.set(r.code, r);
          continue;
        }
        // Prefer the business-scoped row over the org-wide one.
        if (existing.business_id === null && r.business_id !== null) {
          byCode.set(r.code, r);
        }
      }

      return Array.from(byCode.values()).sort((a, b) => a.sequence - b.sequence);
    },
  });
}
