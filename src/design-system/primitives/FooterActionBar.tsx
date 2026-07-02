/**
 * FooterActionBar — the single approved sticky bottom action row for
 * record pages, wizards, and DetailSheets.
 *
 * Layout contract:
 *   [ destructive/secondary-left ]                  [ secondary… primary ]
 *
 * Placement is opinionated on purpose. Modules must not scatter Save /
 * Cancel / Delete buttons across their forms — that is the exact drift
 * this primitive prevents.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FooterActionBarProps {
  /** Left cluster — usually destructive / low-emphasis actions. */
  leading?: ReactNode;
  /** Right cluster — secondary buttons then the primary submit. */
  trailing: ReactNode;
  /**
   * Where the bar is anchored:
   *  - "page"  → fixed to the viewport, offset for the workspace sidebar (default)
   *  - "sheet" → sticky to the enclosing DetailSheet/Dialog footer
   *  - "inline" → renders inline, no fixed positioning (use inside embedded flows)
   */
  anchor?: "page" | "sheet" | "inline";
  className?: string;
}

export function FooterActionBar({
  leading,
  trailing,
  anchor = "page",
  className,
}: FooterActionBarProps) {
  const anchorClass =
    anchor === "page"
      ? "fixed bottom-0 right-0 left-0 z-30 md:left-[calc(var(--ds-app-rail-width)+var(--ds-sidebar-width))]"
      : anchor === "sheet"
        ? "sticky bottom-0 z-10"
        : "";
  return (
    <div
      className={cn(
        "border-t bg-background/95 px-4 py-3 backdrop-blur sm:px-6",
        anchorClass,
        className,
      )}
    >
      <div className="mx-auto flex w-full max-w-[var(--ds-page-max-width)] items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">{leading}</div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {trailing}
        </div>
      </div>
    </div>
  );
}