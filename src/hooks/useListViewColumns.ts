import { useMemo } from "react";
import { useSavedViews, ListViewConfig, ColumnConfig } from "./useSavedViews";

export interface DefaultColumn {
  field: string;
  label: string;
  visible?: boolean;
  sortable?: boolean;
  filterable?: boolean;
}

/**
 * Hook that merges saved list view column configuration with hardcoded defaults.
 * If a default list view exists in Studio, its column visibility/order is respected.
 * Otherwise, falls back to the provided default columns.
 */
export function useListViewColumns(entityType: string, defaultColumns: DefaultColumn[]) {
  const { views, isLoading } = useSavedViews(entityType);

  const columns = useMemo(() => {
    // Find the default list view
    const defaultListView = views.find(v => v.view_type === "list" && v.is_default);
    
    if (!defaultListView) {
      return defaultColumns;
    }

    const config = defaultListView.view_config as ListViewConfig;
    if (!config?.columns || config.columns.length === 0) {
      return defaultColumns;
    }

    // Build a map of saved column configs
    const savedMap = new Map<string, ColumnConfig>();
    config.columns.forEach(col => savedMap.set(col.field, col));

    // Start with saved column order for columns that exist in defaults
    const defaultMap = new Map<string, DefaultColumn>();
    defaultColumns.forEach(col => defaultMap.set(col.field, col));

    const result: DefaultColumn[] = [];

    // First, add columns in saved order (only if they exist in defaults)
    for (const savedCol of config.columns) {
      const defaultCol = defaultMap.get(savedCol.field);
      if (defaultCol && savedCol.visible !== false) {
        result.push({
          ...defaultCol,
          label: savedCol.label || defaultCol.label,
          visible: savedCol.visible ?? true,
        });
      }
    }

    // Then add any default columns not in the saved config
    for (const defCol of defaultColumns) {
      if (!savedMap.has(defCol.field)) {
        result.push(defCol);
      }
    }

    return result;
  }, [views, defaultColumns]);

  const visibleColumns = useMemo(
    () => columns.filter(c => c.visible !== false),
    [columns]
  );

  return {
    columns,
    visibleColumns,
    isLoading,
    hasCustomView: views.some(v => v.view_type === "list" && v.is_default),
  };
}
