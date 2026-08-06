/**
 * DashboardBand — one horizontal band of the reading spine
 * (Status → Act now → Flow → …). Bands are ordered, labelled landmarks;
 * they carry the grid so widgets only declare a semantic span.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DASHBOARD_GRID } from "./spans";

interface DashboardBandProps {
  /** Band label. Rendered as a quiet eyebrow and used as the a11y name. */
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Hide the visible label but keep the accessible name. */
  hideLabel?: boolean;
  className?: string;
}

export function DashboardBand({
  title,
  description,
  actions,
  children,
  hideLabel,
  className,
}: DashboardBandProps) {
  return (
    <section
      aria-label={title}
      className={cn("min-w-0 max-w-full", className)}
    >
      {title && !hideLabel && (
        <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <h2 className="text-[length:var(--ds-text-caption)] font-semibold uppercase tracking-wider text-muted-foreground">
              {title}
            </h2>
            {description && (
              <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(DASHBOARD_GRID, "gap-[var(--ds-dashboard-gap)]")}>
        {children}
      </div>
    </section>
  );
}
