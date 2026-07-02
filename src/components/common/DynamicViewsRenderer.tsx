import { SavedView } from "@/hooks/useSavedViews";
import { DynamicKanbanView, DynamicPivotView, DynamicChartView, DynamicCalendarView, DynamicGanttView } from "@/components/studio";
import type { ViewType } from "@/hooks/useViewMode";
import type { EntityType } from "@/hooks/useEntityFields";
import { useCustomFieldEnrichedData } from "@/hooks/useCustomFieldEnrichedData";

interface DynamicViewsRendererProps<T extends Record<string, unknown>> {
  currentView: ViewType;
  selectedSavedView: SavedView | null;
  data: T[];
  isLoading?: boolean;
  onItemClick?: (item: T) => void;
  /** When provided, custom field values are merged into data objects (prefixed with cf_) */
  entityType?: EntityType;
}

/**
 * Reusable component that renders dynamic Studio views (kanban, pivot, chart, calendar, gantt)
 * based on the current view type and saved view configuration.
 * Returns null for "list" view — the parent page handles list rendering.
 * 
 * When entityType is provided, custom field values from EAV storage are automatically
 * merged into the data objects, enabling grouping/charting by custom fields.
 */
export function DynamicViewsRenderer<T extends Record<string, unknown>>({
  currentView,
  selectedSavedView,
  data,
  isLoading,
  onItemClick,
  entityType,
}: DynamicViewsRendererProps<T>) {
  // Enrich data with custom field values when entityType is provided
  const shouldEnrich = currentView !== "list" && !!selectedSavedView && !!entityType;
  const { enrichedData, isLoading: enrichLoading } = useCustomFieldEnrichedData(
    shouldEnrich ? entityType! : null,
    data
  );

  if (currentView === "list" || !selectedSavedView) return null;

  const viewData = shouldEnrich ? enrichedData : data;
  const combinedLoading = isLoading || enrichLoading;

  switch (currentView) {
    case "kanban":
      return <DynamicKanbanView view={selectedSavedView} data={viewData} isLoading={combinedLoading} onCardClick={onItemClick} />;
    case "pivot":
      return <DynamicPivotView view={selectedSavedView} data={viewData} isLoading={combinedLoading} />;
    case "chart":
      return <DynamicChartView view={selectedSavedView} data={viewData} isLoading={combinedLoading} />;
    case "calendar":
      return <DynamicCalendarView view={selectedSavedView} data={viewData} isLoading={combinedLoading} onItemClick={onItemClick} />;
    case "gantt":
      return <DynamicGanttView view={selectedSavedView} data={viewData} isLoading={combinedLoading} onBarClick={onItemClick} />;
    default:
      return null;
  }
}
