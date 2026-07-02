/**
 * Runtime hook that consumes core_field_overrides and provides
 * field visibility/label resolution for entity list pages and forms.
 * 
 * This is the CONSUMER side of CoreFieldsManager (which is the EDITOR).
 */

import { useMemo } from "react";
import { useCoreFieldOverrides, CoreFieldOverride } from "./useCoreFieldOverrides";
import { EntityType } from "./useEntityFields";

interface CoreFieldDisplay {
  /** Whether a core field should be visible (default: true if no override exists) */
  isFieldVisible: (fieldKey: string) => boolean;
  /** Get display label for a field, falling back to defaultLabel if no override */
  getFieldLabel: (fieldKey: string, defaultLabel: string) => string;
  /** Apply overrides to a column array — filters hidden + relabels */
  applyToColumns: <T extends { field: string; label: string }>(columns: T[]) => T[];
  /** Whether overrides have loaded */
  isLoading: boolean;
}

export function useCoreFieldDisplay(entityType: EntityType): CoreFieldDisplay {
  const { overrides, isLoading } = useCoreFieldOverrides(entityType);

  const overrideMap = useMemo(() => {
    const map = new Map<string, CoreFieldOverride>();
    for (const o of overrides) {
      map.set(o.field_key, o);
    }
    return map;
  }, [overrides]);

  const isFieldVisible = (fieldKey: string): boolean => {
    const override = overrideMap.get(fieldKey);
    // Default to visible if no override exists
    return override ? override.is_visible : true;
  };

  const getFieldLabel = (fieldKey: string, defaultLabel: string): string => {
    const override = overrideMap.get(fieldKey);
    if (override?.label_override) return override.label_override;
    return defaultLabel;
  };

  const applyToColumns = <T extends { field: string; label: string }>(columns: T[]): T[] => {
    if (overrides.length === 0) return columns;

    return columns
      .filter(col => isFieldVisible(col.field))
      .map(col => ({
        ...col,
        label: getFieldLabel(col.field, col.label),
      }));
  };

  return {
    isFieldVisible,
    getFieldLabel,
    applyToColumns,
    isLoading,
  };
}
