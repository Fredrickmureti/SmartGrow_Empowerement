/**
 * PageToolbar — secondary action bar under PageHeader.
 *
 * Hosts: search, filters, view switcher, bulk-action bar. Never repeats
 * the page's primary action (that belongs in PageHeader.actions).
 */
import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageToolbarProps {
  /** Left cluster — typically search + filters. */
  left?: ReactNode;
  /** Right cluster — typically view switcher / secondary actions. */
  right?: ReactNode;
  /** Slot rendered below the row (e.g. active-filter chips, bulk-action bar). */
  belowSlot?: ReactNode;
  className?: string;
}

export function PageToolbar({
  left,
  right,
  belowSlot,
  className,
}: PageToolbarProps) {
  return (
    <div className={cn("mb-4 flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
          {left}
        </div>
        {right && (
          <div className="flex items-center gap-2 flex-shrink-0">{right}</div>
        )}
      </div>
      {belowSlot}
    </div>
  );
}

export default PageToolbar;
