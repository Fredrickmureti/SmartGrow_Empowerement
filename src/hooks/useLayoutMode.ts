/**
 * useLayoutMode Hook
 * 
 * Determines whether to show sidebar (home/dashboard mode) 
 * or top navigation (app workspace mode).
 */

import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { getAppByPath } from "@/lib/apps/registry";

export type LayoutMode = "sidebar" | "workspace";

interface UseLayoutModeResult {
  /** Current layout mode */
  mode: LayoutMode;
  /** Whether we're in app workspace mode (top nav, no sidebar) */
  isWorkspaceMode: boolean;
  /** Whether we're in sidebar mode (sidebar visible) */
  isSidebarMode: boolean;
}

/**
 * Routes that should always use sidebar mode even if they match an app path
 */
const SIDEBAR_MODE_ROUTES = [
  "/dashboard",
  "/onboarding",
  "/app-store",
  "/apps",
];

export function useLayoutMode(): UseLayoutModeResult {
  const location = useLocation();

  const mode = useMemo((): LayoutMode => {
    const path = location.pathname;

    // Check if explicitly sidebar mode route
    if (SIDEBAR_MODE_ROUTES.some(route => path.startsWith(route))) {
      return "sidebar";
    }

    // Check if we're in an app workspace
    const app = getAppByPath(path);
    
    // Platform/settings app uses sidebar mode
    if (app?.isPlatform) {
      return "sidebar";
    }

    // Any other app uses workspace mode
    if (app) {
      return "workspace";
    }

    // Default to sidebar mode
    return "sidebar";
  }, [location.pathname]);

  return {
    mode,
    isWorkspaceMode: mode === "workspace",
    isSidebarMode: mode === "sidebar",
  };
}
