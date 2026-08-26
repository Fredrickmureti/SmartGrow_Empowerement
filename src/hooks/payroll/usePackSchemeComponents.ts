/**
 * usePackSchemeComponents — lists the statutory scheme components published by
 * the localization pack installed for the current organization/business.
 *
 * A `custom_deduction_types` row becomes return- and remittance-eligible only
 * when it is bound to one of these components: the binding supplies the
 * `rule_code` that payroll emits on `payslip_lines`, which is the key both the
 * return engine (`filters.rule_codes`) and the liability writer join on.
 * Without it, the deduction is an ordinary employer-defined deduction.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface PackSchemeComponentOption {
  id: string;
  code: string;
  display_name: string;
  component_type: string;
  rule_code: string | null;
  scheme_name: string | null;
  authority_name: string | null;
  country_code: string | null;
}

export function usePackSchemeComponents() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  return useQuery({
    queryKey: ["payroll", "pack-scheme-components", orgId, businessId],
    enabled: !!orgId && !!businessId,
    queryFn: async (): Promise<PackSchemeComponentOption[]> => {
      const { data: installed } = await supabase
        .from("installed_localization_packs")
        .select("pack_id")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .in("status", ["installed", "active"])
        .maybeSingle();

      if (!installed?.pack_id) return [];

      const { data, error } = await (supabase as any)
        .from("statutory_scheme_components")
        .select(
          "id, code, display_name, component_type, rule_code, is_active, " +
            "statutory_schemes:scheme_id!inner(pack_id, display_name, country_code, " +
            "statutory_authorities:authority_id(display_name))",
        )
        .eq("is_active", true)
        .eq("statutory_schemes.pack_id", installed.pack_id)
        .order("code", { ascending: true });

      if (error) throw error;

      return ((data ?? []) as any[])
        .filter((r) => !!r.rule_code)
        .map((r) => ({
          id: r.id,
          code: r.code,
          display_name: r.display_name,
          component_type: r.component_type,
          rule_code: r.rule_code,
          scheme_name: r.statutory_schemes?.display_name ?? null,
          authority_name:
            r.statutory_schemes?.statutory_authorities?.display_name ?? null,
          country_code: r.statutory_schemes?.country_code ?? null,
        }));
    },
  });
}
