import { useState, useEffect } from "react";
import { LayoutGrid, Table, BarChart3, PieChart, Calendar, GanttChart, ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSavedViews, SavedView } from "@/hooks/useSavedViews";
import { cn } from "@/lib/utils";

export type ViewType = "list" | "kanban" | "pivot" | "chart" | "calendar" | "gantt";

interface ViewSwitcherProps {
  entityType: string;
  currentView: ViewType;
  onViewChange: (view: ViewType, savedView?: SavedView) => void;
  className?: string;
}

const VIEW_ICONS: Record<ViewType, React.ReactNode> = {
  list: <Table className="h-4 w-4" />,
  kanban: <LayoutGrid className="h-4 w-4" />,
  pivot: <PieChart className="h-4 w-4" />,
  chart: <BarChart3 className="h-4 w-4" />,
  calendar: <Calendar className="h-4 w-4" />,
  gantt: <GanttChart className="h-4 w-4" />,
};

const VIEW_LABELS: Record<ViewType, string> = {
  list: "List View",
  kanban: "Kanban View",
  pivot: "Pivot View",
  chart: "Chart View",
  calendar: "Calendar View",
  gantt: "Gantt View",
};

export function ViewSwitcher({ 
  entityType, 
  currentView, 
  onViewChange,
  className 
}: ViewSwitcherProps) {
  const { views, isLoading } = useSavedViews(entityType);
  const [selectedSavedView, setSelectedSavedView] = useState<SavedView | null>(null);
  
  // Group saved views by type
  const kanbanViews = views.filter(v => v.view_type === "kanban");
  const pivotViews = views.filter(v => v.view_type === "pivot");
  const chartViews = views.filter(v => v.view_type === "chart");
  const calendarViews = views.filter(v => v.view_type === "calendar");
  const ganttViews = views.filter(v => v.view_type === "gantt");

  // Load last used view from localStorage
  useEffect(() => {
    const savedViewKey = `view_${entityType}`;
    const savedViewData = localStorage.getItem(savedViewKey);
    if (savedViewData) {
      try {
        const { viewType, viewId } = JSON.parse(savedViewData);
        if (viewId) {
          const view = views.find(v => v.id === viewId);
          if (view) {
            setSelectedSavedView(view);
            onViewChange(viewType as ViewType, view);
            return;
          }
        }
        onViewChange(viewType as ViewType);
      } catch (e) {
        // Ignore parse errors
      }
    }
  }, [entityType, views]);

  const handleViewSelect = (viewType: ViewType, savedView?: SavedView) => {
    setSelectedSavedView(savedView || null);
    onViewChange(viewType, savedView);
    
    // Persist selection
    const savedViewKey = `view_${entityType}`;
    localStorage.setItem(savedViewKey, JSON.stringify({
      viewType,
      viewId: savedView?.id || null,
    }));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="outline" 
          size="sm" 
          className={cn("gap-2", className)}
        >
          {VIEW_ICONS[currentView]}
          <span className="hidden sm:inline">
            {selectedSavedView?.view_name || VIEW_LABELS[currentView]}
          </span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {/* Default List View */}
        <DropdownMenuItem 
          onClick={() => handleViewSelect("list")}
          className="gap-2"
        >
          <Table className="h-4 w-4" />
          <span className="flex-1">List View</span>
          {currentView === "list" && !selectedSavedView && (
            <Check className="h-4 w-4 text-primary" />
          )}
        </DropdownMenuItem>

        {/* Kanban Views */}
        {kanbanViews.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              Kanban Views
            </div>
            {kanbanViews.map(view => (
              <DropdownMenuItem
                key={view.id}
                onClick={() => handleViewSelect("kanban", view)}
                className="gap-2 pl-4"
              >
                <LayoutGrid className="h-4 w-4" />
                <span className="flex-1">{view.view_name}</span>
                {selectedSavedView?.id === view.id && (
                  <Check className="h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {/* Pivot Views */}
        {pivotViews.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              Pivot Views
            </div>
            {pivotViews.map(view => (
              <DropdownMenuItem
                key={view.id}
                onClick={() => handleViewSelect("pivot", view)}
                className="gap-2 pl-4"
              >
                <PieChart className="h-4 w-4" />
                <span className="flex-1">{view.view_name}</span>
                {selectedSavedView?.id === view.id && (
                  <Check className="h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {/* Chart Views */}
        {chartViews.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              Chart Views
            </div>
            {chartViews.map(view => (
              <DropdownMenuItem
                key={view.id}
                onClick={() => handleViewSelect("chart", view)}
                className="gap-2 pl-4"
              >
                <BarChart3 className="h-4 w-4" />
                <span className="flex-1">{view.view_name}</span>
                {selectedSavedView?.id === view.id && (
                  <Check className="h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {/* Calendar Views */}
        {calendarViews.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              Calendar Views
            </div>
            {calendarViews.map(view => (
              <DropdownMenuItem
                key={view.id}
                onClick={() => handleViewSelect("calendar", view)}
                className="gap-2 pl-4"
              >
                <Calendar className="h-4 w-4" />
                <span className="flex-1">{view.view_name}</span>
                {selectedSavedView?.id === view.id && (
                  <Check className="h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {/* Gantt Views */}
        {ganttViews.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              Gantt Views
            </div>
            {ganttViews.map(view => (
              <DropdownMenuItem
                key={view.id}
                onClick={() => handleViewSelect("gantt", view)}
                className="gap-2 pl-4"
              >
                <GanttChart className="h-4 w-4" />
                <span className="flex-1">{view.view_name}</span>
                {selectedSavedView?.id === view.id && (
                  <Check className="h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {views.length === 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-3 text-xs text-muted-foreground text-center">
              No saved views. Create views in Studio.
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}