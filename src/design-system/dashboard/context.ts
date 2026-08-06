/**
 * Dashboard context — density + column model shared by every widget on a
 * canvas. Widgets never read Tailwind breakpoints directly; they ask the
 * canvas. See docs/design-system.md § Dashboards.
 */
import { createContext, useContext } from "react";

export type DashboardDensity = "comfortable" | "compact";

export interface DashboardContextValue {
  density: DashboardDensity;
}

export const DashboardContext = createContext<DashboardContextValue>({
  density: "comfortable",
});

export function useDashboard(): DashboardContextValue {
  return useContext(DashboardContext);
}
