import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { CustomFieldFilter } from "@/components/common/CustomFieldFilters";
import type { EntityType } from "@/hooks/useEntityFields";

/**
 * Hook that manages custom field filter state and computes
 * which entity IDs match the active filters.
 * 
 * Usage:
 *   const { filters, setFilters, filterEntityIds, isFiltering } = useCustomFieldFiltering("contact");
 *   // Then filter your data: filteredData = isFiltering ? data.filter(d => filterEntityIds.has(d.id)) : data;
 */
export function useCustomFieldFiltering(entityType: EntityType) {
  const [filters, setFilters] = useState<CustomFieldFilter[]>([]);
  const { session } = useAuth();

  // Only query when filters are active
  const hasFilters = filters.length > 0;

  const { data: matchingIds } = useQuery({
    queryKey: ["custom-field-filter-ids", entityType, filters],
    queryFn: async () => {
      if (!session?.user || filters.length === 0) return null;

      // For each filter, find entity_ids that match
      // All filters must match (AND logic)
      let entityIds: Set<string> | null = null;

      for (const filter of filters) {
        const query = supabase
          .from("entity_field_values")
          .select("entity_id")
          .eq("entity_type", entityType)
          .eq("field_key", filter.fieldKey);

        // For text-like filters, use ilike for partial match
        if (filter.value === "true" || filter.value === "false") {
          query.eq("field_value", filter.value);
        } else {
          query.ilike("field_value", `%${filter.value}%`);
        }

        const { data, error } = await query;
        if (error) throw error;

        const ids = new Set<string>((data || []).map((r: any) => r.entity_id as string));
        if (entityIds === null) {
          entityIds = ids;
        } else {
          // Intersect
          entityIds = new Set([...entityIds].filter((id) => ids.has(id)));
        }
      }

      return entityIds ? [...entityIds] : [];
    },
    enabled: hasFilters && !!session?.user,
    staleTime: 10_000,
  });

  const filterEntityIds = useMemo(() => {
    if (!matchingIds) return new Set<string>();
    return new Set(matchingIds);
  }, [matchingIds]);

  return {
    filters,
    setFilters,
    filterEntityIds,
    isFiltering: hasFilters,
  };
}
