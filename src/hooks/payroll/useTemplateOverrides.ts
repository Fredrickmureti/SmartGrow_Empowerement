/**
 * Tenant overrides for localization-pack tax-certificate and statutory-return
 * templates. Override wins at edge-function generation time. The override
 * snapshots the pack template's `updated_at` so generation can detect drift
 * (TEMPLATE_OUT_OF_DATE) and force re-acknowledgement.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

type Kind = "certificate" | "return";

const TABLE = {
  certificate: "payroll_certificate_template_overrides",
  return: "payroll_return_template_overrides",
} as const;

export interface TemplateOverride {
  id: string;
  organization_id: string;
  business_id: string;
  template_code: string;
  body: any;
  layout: string | null;
  notes: string | null;
  base_pack_id: string | null;
  base_template_updated_at: string | null;
  override_version: number;
  created_at: string;
  updated_at: string;
  /** Slice-C operational override columns (nullable = inherit). */
  submission_channel?: string | null;
  submission_format?: any | null;
  output?: string | null;
  due_day?: number | null;
  due_month_offset?: number | null;
}

export function useTemplateOverrides(kind: Kind) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["payroll", "template-overrides", kind, orgId, businessId],
    enabled: !!orgId && !!businessId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from(TABLE[kind])
        .select("*")
        .eq("organization_id", orgId)
        .eq("business_id", businessId);
      if (error) throw error;
      return (data ?? []) as TemplateOverride[];
    },
  });
}

export function useSaveTemplateOverride(kind: Kind) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      template_code: string;
      body: any;
      layout?: string | null;
      notes: string;
      base_pack_id: string | null;
      base_template_updated_at: string;
      /** Slice-C operational overrides (return kind only). Pass null to clear. */
      submission_channel?: string | null;
      submission_format?: any | null;
      output?: string | null;
      due_day?: number | null;
      due_month_offset?: number | null;
    }) => {
      if ((input.notes ?? "").trim().length < 10) {
        throw new Error("A reason of at least 10 characters is required.");
      }
      const { data: { user } } = await supabase.auth.getUser();
      const row: Record<string, any> = {
        organization_id: currentOrg?.id,
        business_id: currentBusiness?.id,
        template_code: input.template_code,
        body: input.body,
        notes: input.notes,
        base_pack_id: input.base_pack_id,
        base_template_updated_at: input.base_template_updated_at,
        updated_by: user?.id,
        created_by: user?.id,
      };
      if (kind === "certificate") row.layout = input.layout ?? null;
      if (kind === "return") {
        // Only forward operational fields when the caller passed them — `undefined`
        // means "leave existing override column alone"; explicit `null` means
        // "clear to inherit pack default".
        for (const k of [
          "submission_channel",
          "submission_format",
          "output",
          "due_day",
          "due_month_offset",
        ] as const) {
          if (k in input) row[k] = (input as any)[k];
        }
      }
      const { data, error } = await (supabase as any)
        .from(TABLE[kind])
        .upsert(row, { onConflict: "business_id,template_code" })
        .select()
        .single();
      if (error) throw error;
      return data as TemplateOverride;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll", "template-overrides", kind] });
      qc.invalidateQueries({ queryKey: ["payroll", "return-templates"] });
    },
  });
}

export function useResetTemplateOverride(kind: Kind) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (templateCode: string) => {
      const { error } = await (supabase as any)
        .from(TABLE[kind])
        .delete()
        .eq("organization_id", currentOrg?.id)
        .eq("business_id", currentBusiness?.id)
        .eq("template_code", templateCode);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll", "template-overrides", kind] });
    },
  });
}
