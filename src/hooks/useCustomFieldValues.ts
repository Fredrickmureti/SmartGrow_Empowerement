import { useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { CustomFieldFilter } from "@/components/common/CustomFieldFilters";

/**
 * Hook to batch-load custom field values for a list of entities,
 * avoiding N+1 queries. Also provides client-side filtering by custom field values.
 */
export function useCustomFieldValues(entityType: string, entityIds: string[]) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const { data: fieldValues, isLoading } = useQuery({
    queryKey: ["custom-field-values", entityType, currentOrg?.id, entityIds.sort().join(",")],
    queryFn: async () => {
      if (!currentOrg?.id || entityIds.length === 0) return {};

      const { data, error } = await supabase
        .from("entity_field_values")
        .select("entity_id, field_key, field_value")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType)
        .in("entity_id", entityIds);

      if (error) throw error;

      // Group by entity_id -> { field_key: field_value }
      const result: Record<string, Record<string, string>> = {};
      for (const row of data || []) {
        if (!result[row.entity_id]) result[row.entity_id] = {};
        result[row.entity_id][row.field_key] = row.field_value || "";
      }
      return result;
    },
    enabled: !!currentOrg?.id && entityIds.length > 0,
    staleTime: 30000,
  });

  /**
   * Filter entities by custom field filters.
   * Returns only entity IDs that match ALL active filters.
   */
  const filterByCustomFields = useCallback(
    <T extends { id: string }>(items: T[], filters: CustomFieldFilter[]): T[] => {
      if (!filters.length || !fieldValues) return items;

      return items.filter((item) => {
        const values = fieldValues[item.id] || {};
        return filters.every((filter) => {
          const fieldValue = values[filter.fieldKey] || "";
          if (!filter.value) return true;
          // Case-insensitive contains for text, exact match for select/boolean
          return fieldValue.toLowerCase().includes(filter.value.toLowerCase());
        });
      });
    },
    [fieldValues]
  );

  return {
    fieldValues: fieldValues || {},
    isLoading,
    filterByCustomFields,
  };
}
