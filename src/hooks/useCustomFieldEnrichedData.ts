/**
 * Hook that batch-fetches custom field values for a list of entity IDs
 * and merges them into data objects for use in dynamic views (kanban, chart, pivot, etc.).
 * 
 * This bridges the EAV storage gap — custom fields stored in entity_field_values
 * get surfaced as regular properties on data objects so DynamicViewsRenderer
 * can group/chart/display by custom fields.
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import type { EntityType } from "@/hooks/useEntityFields";

interface CustomFieldEnrichmentResult<T extends Record<string, unknown>> {
  enrichedData: T[];
  isLoading: boolean;
}

export function useCustomFieldEnrichedData<T extends Record<string, unknown>>(
  entityType: EntityType | null,
  data: T[],
  idField: string = "id"
): CustomFieldEnrichmentResult<T> {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [enrichedData, setEnrichedData] = useState<T[]>(data);
  const [isLoading, setIsLoading] = useState(false);

  const enrich = useCallback(async () => {
    if (!entityType || !currentOrg || data.length === 0) {
      setEnrichedData(data);
      return;
    }

    const entityIds = data
      .map(d => d[idField] as string)
      .filter(Boolean);

    if (entityIds.length === 0) {
      setEnrichedData(data);
      return;
    }

    setIsLoading(true);
    try {
      // Fetch all custom field values for these entities in one query
      const { data: fieldValues, error } = await supabase
        .from("entity_field_values")
        .select("entity_id, field_key, field_value")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType)
        .in("entity_id", entityIds);

      if (error) {
        console.error("Error fetching custom field values for enrichment:", error);
        setEnrichedData(data);
        return;
      }

      if (!fieldValues || fieldValues.length === 0) {
        setEnrichedData(data);
        return;
      }

      // Build a map: entityId -> { fieldKey: fieldValue }
      const valuesByEntity = new Map<string, Record<string, string>>();
      for (const fv of fieldValues) {
        const entityId = fv.entity_id as string;
        if (!valuesByEntity.has(entityId)) {
          valuesByEntity.set(entityId, {});
        }
        valuesByEntity.get(entityId)![fv.field_key as string] = fv.field_value as string;
      }

      // Merge custom field values into data objects with cf_ prefix to avoid collisions
      const merged = data.map(item => {
        const id = item[idField] as string;
        const customValues = valuesByEntity.get(id);
        if (!customValues) return item;

        const enriched = { ...item };
        for (const [key, value] of Object.entries(customValues)) {
          (enriched as Record<string, unknown>)[`cf_${key}`] = value;
        }
        return enriched;
      });

      setEnrichedData(merged);
    } catch (err) {
      console.error("Custom field enrichment failed:", err);
      setEnrichedData(data);
    } finally {
      setIsLoading(false);
    }
  }, [entityType, currentOrg?.id, data, idField]);

  useEffect(() => {
    enrich();
  }, [enrich]);

  return { enrichedData, isLoading };
}
