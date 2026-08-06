/**
 * DashboardCanvas — the root of every dashboard in the ERP.
 *
 * Owns density and the column model; provides both to the bands and
 * widgets below it. A dashboard page renders exactly one canvas and then
 * declares bands — it never authors grid geometry itself.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DashboardContext, type DashboardDensity } from "./context";

interface DashboardCanvasProps {
  children: ReactNode;
  /** Operational dashboards may opt into a tighter rhythm. */
  density?: DashboardDensity;
  /** Accessible name for the dashboard region. */
  label?: string;
  className?: string;
}

export function DashboardCanvas({
  children,
  density = "comfortable",
  label = "Dashboard",
  className,
}: DashboardCanvasProps) {
  return (
    <DashboardContext.Provider value={{ density }}>
      <div
        role="region"
        aria-label={label}
        data-dashboard-density={density}
        className={cn(
          "min-w-0 max-w-full overflow-x-hidden",
          "flex flex-col gap-[var(--ds-dashboard-band-gap)]",
          density === "compact" && "[--ds-dashboard-band-gap:1rem] [--ds-dashboard-gap:0.75rem]",
          className,
        )}
      >
        {children}
      </div>
    </DashboardContext.Provider>
  );
}
