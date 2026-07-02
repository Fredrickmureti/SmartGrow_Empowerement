/**
 * useStatutoryFieldConfig — thin wrapper around useEmployeeRequirements
 * that lets HR users add tenant overrides on top of pack-published
 * defaults.
 *
 * History: this hook used to read its own table (`hr_statutory_field_config`)
 * AND maintain a hardcoded global TypeScript catalog (`KNOWN_TYPES`).
 * Both have been removed. The catalog now comes from the installed
 * localization pack via `pack_requirements`; tenant overrides are
 * persisted to the same table with `source = 'tenant_override'`.
 *
 * HR users do NOT see other countries' identifiers anymore. A Kenyan
 * workspace sees Kenyan identifiers. A UK workspace sees UK
 * identifiers. No pack installed → empty state with CTA.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { useEmployeeRequirements, type EmployeeRequirement } from "./useEmployeeRequirements";

export type StatutoryRequirement = EmployeeRequirement;

export interface StatutoryOverrideInput {
  requirement_key: string;
  country_code?: string | null;
  label?: string | null;
  help_text?: string | null;
  is_required?: boolean;
  blocks_onboarding?: boolean;
  blocks_payroll?: boolean;
  is_active?: boolean;
}

export function useStatutoryFieldConfig() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();
  const req = useEmployeeRequirements({ module: "payroll" });

  const upsertOverride = useMutation({
    mutationFn: async (input: StatutoryOverrideInput) => {
      if (!currentOrg?.id || !currentBusiness?.id) {
        throw new Error("Select a business first");
      }
      const { error } = await (supabase as any).rpc("upsert_statutory_override", {
        p_business_id: currentBusiness.id,
        p_organization_id: currentOrg.id,
        p_requirement_key: input.requirement_key,
        p_country_code: input.country_code ?? null,
        p_label: input.label ?? null,
        p_help_text: input.help_text ?? null,
        p_is_required: input.is_required ?? null,
        p_blocks_onboarding: input.blocks_onboarding ?? null,
        p_blocks_payroll: input.blocks_payroll ?? null,
        p_is_active: input.is_active ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-required-employee-fields"] });
      toast.success("Saved");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const resetToPackDefault = useMutation({
    mutationFn: async (input: { requirement_key: string; country_code: string | null }) => {
      if (!currentBusiness?.id || !currentOrg?.id) throw new Error("Select a business first");
      const { error } = await (supabase as any).rpc("reset_statutory_override", {
        p_business_id: currentBusiness.id,
        p_organization_id: currentOrg.id,
        p_requirement_key: input.requirement_key,
        p_country_code: input.country_code ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-required-employee-fields"] });
      toast.success("Reset to pack default");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });


  return {
    requirements: req.statutory,
    isLoading: req.isLoading,
    upsertOverride,
    resetToPackDefault,
  };
}
