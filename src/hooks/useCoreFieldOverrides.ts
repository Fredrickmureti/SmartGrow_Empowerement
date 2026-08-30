/**
 * Core Field Overrides Hook
 * 
 * Manages org-level overrides for built-in entity fields:
 * visibility toggles, display order, and label overrides.
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { EntityType } from "./useEntityFields";

export interface CoreFieldOverride {
  id: string;
  organization_id: string;
  entity_type: string;
  field_key: string;
  is_visible: boolean;
  display_order: number;
  label_override: string | null;
  created_at: string;
  updated_at: string;
}

export function useCoreFieldOverrides(entityType?: EntityType) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [overrides, setOverrides] = useState<CoreFieldOverride[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchOverrides = useCallback(async () => {
    // Guard against null currentBusiness — query would throw on .id access.
    if (!currentOrg || !currentBusiness) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      let query = supabase
        .from("core_field_overrides")
        .select("*")
        .eq("organization_id", currentOrg.id);

      if (entityType) {
        query = query.eq("entity_type", entityType);
      }

      const { data, error } = await query.order("display_order", { ascending: true });
      if (error) throw error;
      setOverrides((data || []) as CoreFieldOverride[]);
    } catch (error) {
      console.error("Error fetching core field overrides:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, entityType]);

  useEffect(() => {
    fetchOverrides();
  }, [fetchOverrides]);

  const upsertOverride = useCallback(async (
    entityType: string,
    fieldKey: string,
    updates: Partial<Pick<CoreFieldOverride, "is_visible" | "display_order" | "label_override">>
  ) => {
    if (!currentOrg) throw new Error("No organization selected");

    const existing = overrides.find(
      o => o.entity_type === entityType && o.field_key === fieldKey
    );

    if (existing) {
      const { error } = await supabase
        .from("core_field_overrides")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("core_field_overrides")
        .insert({
          organization_id: currentOrg.id,
          entity_type: entityType,
          field_key: fieldKey,
          is_visible: updates.is_visible ?? true,
          display_order: updates.display_order ?? 0,
          label_override: updates.label_override ?? null,
        });
      if (error) throw error;
    }

    await fetchOverrides();
  }, [currentOrg?.id, overrides, fetchOverrides]);

  const bulkUpdate = useCallback(async (
    entityType: string,
    updates: Array<{ field_key: string; is_visible: boolean; display_order: number; label_override: string | null }>
  ) => {
    if (!currentOrg) return;
    
    try {
      for (const update of updates) {
        await upsertOverride(entityType, update.field_key, {
          is_visible: update.is_visible,
          display_order: update.display_order,
          label_override: update.label_override,
        });
      }
      toast.success("Core field overrides saved");
    } catch (error) {
      toast.error("Failed to save overrides");
      throw error;
    }
  }, [currentOrg?.id, upsertOverride]);

  const getOverride = useCallback((entityType: string, fieldKey: string): CoreFieldOverride | undefined => {
    return overrides.find(o => o.entity_type === entityType && o.field_key === fieldKey);
  }, [overrides]);

  const getVisibleFields = useCallback((entityType: string, defaultFields: { field: string; label: string }[]) => {
    const entityOverrides = overrides.filter(o => o.entity_type === entityType);
    if (entityOverrides.length === 0) return defaultFields;

    const overrideMap = new Map(entityOverrides.map(o => [o.field_key, o]));

    return defaultFields
      .map(f => {
        const override = overrideMap.get(f.field);
        if (override && !override.is_visible) return null;
        return {
          field: f.field,
          label: override?.label_override || f.label,
          display_order: override?.display_order ?? 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a!.display_order - b!.display_order)) as { field: string; label: string; display_order: number }[];
  }, [overrides]);

  return {
    overrides,
    isLoading,
    upsertOverride,
    bulkUpdate,
    getOverride,
    getVisibleFields,
    refetch: fetchOverrides,
  };
}
