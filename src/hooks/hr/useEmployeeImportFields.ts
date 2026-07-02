/**
 * useEmployeeImportFields — composes the importable employee field list at
 * runtime from pack_requirements + entity_field_configs (plus the static
 * core list). Driven by the current org/business so installing a
 * localization pack immediately expands the import template — no engineering
 * change required.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  composeEmployeeImportFields,
  type PackRequirementRow,
  type EntityFieldConfigRow,
} from "@/lib/hr/employeeImportSchema";
import type { FieldDefinition } from "@/lib/importUtils";

export function useEmployeeImportFields(
  organizationId: string | null | undefined,
  businessId: string | null | undefined,
): { fields: FieldDefinition[]; isLoading: boolean } {
  const enabled = !!organizationId;

  const packReqQuery = useQuery({
    queryKey: ["employee-import-fields", "pack_requirements", organizationId, businessId],
    enabled,
    queryFn: async (): Promise<PackRequirementRow[]> => {
      let q = (supabase as any)
        .from("pack_requirements")
        .select(
          "requirement_key, label, data_type, is_required, is_active, validation_regex, help_text, sort_order, scope, source, organization_id, business_id",
        )
        .eq("scope", "statutory_identifier")
        .eq("is_active", true)
        .eq("organization_id", organizationId);
      if (businessId) q = q.or(`business_id.is.null,business_id.eq.${businessId}`);
      const { data, error } = await q;
      if (error) throw error;
      // De-dupe by requirement_key with tenant_override winning over pack rows.
      const byKey = new Map<string, PackRequirementRow & { source?: string }>();
      for (const r of (data || []) as Array<PackRequirementRow & { source?: string }>) {
        const prev = byKey.get(r.requirement_key);
        if (!prev) { byKey.set(r.requirement_key, r); continue; }
        if (r.source === "tenant_override" && prev.source !== "tenant_override") {
          byKey.set(r.requirement_key, r);
        }
      }
      return Array.from(byKey.values());
    },
  });

  const fieldConfigQuery = useQuery({
    queryKey: ["employee-import-fields", "entity_field_configs", organizationId, businessId],
    enabled,
    queryFn: async (): Promise<EntityFieldConfigRow[]> => {
      let q = (supabase as any)
        .from("entity_field_configs")
        .select("field_key, field_label, field_type, is_required, is_visible, options, display_order, entity_type, validation_rules, help_text, business_id")
        .eq("entity_type", "employee")
        .eq("is_visible", true)
        .eq("organization_id", organizationId);
      if (businessId) q = q.or(`business_id.is.null,business_id.eq.${businessId}`);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as EntityFieldConfigRow[];
    },
  });

  const fields = composeEmployeeImportFields(
    packReqQuery.data || [],
    fieldConfigQuery.data || [],
  );

  return { fields, isLoading: packReqQuery.isLoading || fieldConfigQuery.isLoading };
}
