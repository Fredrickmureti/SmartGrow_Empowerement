import { useState, useEffect, useCallback } from "react";
import { useSavedViews, SavedView } from "./useSavedViews";

export type ViewType = "list" | "kanban" | "pivot" | "chart" | "calendar" | "gantt";

interface UseViewModeOptions {
  entityType: string;
  defaultView?: ViewType;
}

interface UseViewModeReturn {
  currentView: ViewType;
  selectedSavedView: SavedView | null;
  setView: (view: ViewType, savedView?: SavedView | null) => void;
  savedViews: SavedView[];
  isLoading: boolean;
}

const STORAGE_KEY_PREFIX = "entity_view_mode_";

export function useViewMode({ entityType, defaultView = "list" }: UseViewModeOptions): UseViewModeReturn {
  const { views: savedViews, isLoading } = useSavedViews(entityType);
  const [currentView, setCurrentView] = useState<ViewType>(defaultView);
  const [selectedSavedView, setSelectedSavedView] = useState<SavedView | null>(null);

  // Load persisted view on mount
  useEffect(() => {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${entityType}`);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed.viewType) {
          setCurrentView(parsed.viewType as ViewType);
        }
        if (parsed.savedViewId && savedViews.length > 0) {
          const found = savedViews.find(v => v.id === parsed.savedViewId);
          if (found) {
            setSelectedSavedView(found);
          }
        }
      } catch (e) {
        console.error("Failed to parse stored view mode:", e);
      }
    }
  }, [entityType, savedViews]);

  const setView = useCallback((view: ViewType, savedView?: SavedView | null) => {
    setCurrentView(view);
    setSelectedSavedView(savedView ?? null);

    // Persist to localStorage
    localStorage.setItem(
      `${STORAGE_KEY_PREFIX}${entityType}`,
      JSON.stringify({
        viewType: view,
        savedViewId: savedView?.id || null,
      })
    );
  }, [entityType]);

  return {
    currentView,
    selectedSavedView,
    setView,
    savedViews,
    isLoading,
  };
}
