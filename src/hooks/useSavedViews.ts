import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { EntityType } from "./useEntityFields";

export type ViewType = "list" | "kanban" | "pivot" | "chart" | "calendar" | "gantt";

export interface FilterCondition {
  field: string;
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "not_contains" | "is_empty" | "is_not_empty" | "in" | "not_in";
  value?: string | number | boolean | string[];
}

export interface SortConfig {
  field: string;
  direction: "asc" | "desc";
}

export interface ColumnConfig {
  field: string;
  label?: string;
  width?: number;
  visible?: boolean;
  sortable?: boolean;
  filterable?: boolean;
}

export interface ListViewConfig {
  columns: ColumnConfig[];
  sort?: SortConfig;
  filters?: FilterCondition[];
  groupBy?: string;
}

export interface KanbanViewConfig {
  groupBy: string;
  columns: ColumnConfig[];
  cardFields?: string[];
  swimlaneBy?: string;
}

export interface PivotViewConfig {
  rows: string[];
  cols: string[];
  values: Array<{
    field: string;
    aggregate: "sum" | "count" | "avg" | "min" | "max";
  }>;
  filters?: FilterCondition[];
}

export interface ChartViewConfig {
  type: "bar" | "line" | "pie" | "doughnut" | "area" | "scatter";
  xAxis: string;
  yAxis: string;
  groupBy?: string;
  colors?: string[];
}

export interface CalendarViewConfig {
  dateField: string;
  endDateField?: string;
  titleField: string;
  colorField?: string;
  allDayField?: string;
}

export interface GanttViewConfig {
  startField: string;
  endField: string;
  nameField: string;
  progressField?: string;
  dependencyField?: string;
}

export type ViewConfig = 
  | ListViewConfig 
  | KanbanViewConfig 
  | PivotViewConfig 
  | ChartViewConfig 
  | CalendarViewConfig 
  | GanttViewConfig;

export interface QuickFilter {
  id: string;
  label: string;
  filters: FilterCondition[];
  icon?: string;
  color?: string;
}

export interface SavedView {
  id: string;
  organization_id: string;
  user_id: string | null;
  entity_type: EntityType | string;
  view_name: string;
  view_type: ViewType;
  is_shared: boolean;
  is_default: boolean;
  view_config: ViewConfig;
  quick_filters: QuickFilter[];
  created_at: string;
  updated_at: string;
}

// View type labels for UI
export const VIEW_TYPE_LABELS: Record<ViewType, string> = {
  list: "List",
  kanban: "Kanban",
  pivot: "Pivot Table",
  chart: "Chart",
  calendar: "Calendar",
  gantt: "Gantt Chart",
};

// View type icons
export const VIEW_TYPE_ICONS: Record<ViewType, string> = {
  list: "List",
  kanban: "Columns3",
  pivot: "Table2",
  chart: "BarChart3",
  calendar: "Calendar",
  gantt: "GanttChart",
};

/**
 * Hook for managing saved views
 */
export function useSavedViews(entityType: EntityType | string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const [views, setViews] = useState<SavedView[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeView, setActiveView] = useState<SavedView | null>(null);

  const fetchViews = useCallback(async () => {
    // Guard against null currentBusiness — BusinessContext may still be resolving.
    // Without this guard, currentBusiness.id throws "Cannot read properties of null".
    if (!currentOrg || !currentBusiness || !user) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("saved_views")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType)
        .or(`user_id.eq.${user.id},is_shared.eq.true`)
        .order("is_default", { ascending: false })
        .order("view_name");

      if (error) throw error;
      
      const viewsData = (data || []) as unknown as SavedView[];
      setViews(viewsData);

      // Set active view to default if exists and no active view selected
      if (!activeView) {
        const defaultView = viewsData.find(v => v.is_default);
        if (defaultView) {
          setActiveView(defaultView);
        }
      }
    } catch (error) {
      console.error("Error fetching saved views:", error);
      toast.error("Failed to fetch saved views");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, entityType, user?.id, activeView]);

  useEffect(() => {
    fetchViews();
  }, [fetchViews]);

  const createView = async (
    viewName: string,
    viewType: ViewType,
    viewConfig: ViewConfig,
    options?: { isShared?: boolean; isDefault?: boolean; quickFilters?: QuickFilter[] }
  ) => {
    if (!currentOrg || !user) throw new Error("No organization or user selected");

    if (options?.isDefault) {
      await supabase
        .from("saved_views")
        .update({ is_default: false })
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType)
        .eq("user_id", user.id);
    }

    const { data, error } = await supabase
      .from("saved_views")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        user_id: user.id,
        entity_type: entityType,
        view_name: viewName,
        view_type: viewType,
        view_config: viewConfig as any,
        is_shared: options?.isShared ?? false,
        is_default: options?.isDefault ?? false,
        quick_filters: (options?.quickFilters ?? []) as any,
      } as any)
      .select()
      .single();

    if (error) throw error;
    
    toast.success(`View "${viewName}" created`);
    await fetchViews();
    return data as unknown as SavedView;
  };

  const updateView = async (id: string, updates: Partial<SavedView>) => {
    if (!currentOrg || !user) throw new Error("No organization or user selected");

    if (updates.is_default) {
      await supabase
        .from("saved_views")
        .update({ is_default: false })
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType)
        .eq("user_id", user.id);
    }

    const { error } = await supabase
      .from("saved_views")
      .update(updates as any)
      .eq("id", id);

    if (error) throw error;
    
    toast.success("View updated");
    await fetchViews();

    // Update active view if it was the one updated
    if (activeView?.id === id) {
      setActiveView(prev => prev ? { ...prev, ...updates } : null);
    }
  };

  const deleteView = async (id: string) => {
    const { error } = await supabase
      .from("saved_views")
      .delete()
      .eq("id", id);

    if (error) throw error;
    
    toast.success("View deleted");
    
    // Clear active view if it was deleted
    if (activeView?.id === id) {
      setActiveView(null);
    }
    
    await fetchViews();
  };

  const duplicateView = async (id: string) => {
    const view = views.find(v => v.id === id);
    if (!view) throw new Error("View not found");

    return createView(
      `${view.view_name} (Copy)`,
      view.view_type,
      view.view_config,
      { isShared: false, isDefault: false, quickFilters: view.quick_filters }
    );
  };

  const setAsDefault = async (id: string) => {
    await updateView(id, { is_default: true });
  };

  const toggleSharing = async (id: string) => {
    const view = views.find(v => v.id === id);
    if (view) {
      await updateView(id, { is_shared: !view.is_shared });
    }
  };

  // Get views by type
  const getViewsByType = (viewType: ViewType) => {
    return views.filter(v => v.view_type === viewType);
  };

  // Get user's own views
  const myViews = views.filter(v => v.user_id === user?.id);

  // Get shared views
  const sharedViews = views.filter(v => v.is_shared && v.user_id !== user?.id);

  return {
    views,
    isLoading,
    activeView,
    setActiveView,
    createView,
    updateView,
    deleteView,
    duplicateView,
    setAsDefault,
    toggleSharing,
    getViewsByType,
    myViews,
    sharedViews,
    refreshViews: fetchViews,
  };
}
