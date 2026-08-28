/**
 * Section — a titled card-style container for a single chunk of page content
 * (a table, a chart, a form sub-section). Replaces ad-hoc <Card> + <h2>
 * markup across modules.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionProps {
  /** DOM id — lets a summary card scroll-link to its drill-down section. */
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Strip background + border for full-bleed embeds. */
  unstyled?: boolean;
  className?: string;
  contentClassName?: string;
}

export function Section({
  id,
  title,
  description,
  actions,
  children,
  unstyled,
  className,
  contentClassName,
}: SectionProps) {
  return (
    <section
      id={id}
      className={cn(
        "w-full min-w-0 max-w-full",
        !unstyled &&
          "rounded-[var(--ds-radius-lg)] border bg-card shadow-[var(--ds-elevation-1)]",
        className,
      )}
    >
      {(title || actions) && (
        <header
          className={cn(
            "flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-4 sm:px-5",
            !unstyled && "pb-3",
          )}
        >
          <div className="min-w-0 flex-1 basis-[14rem]">
            {title && (
              <h2 className="text-[length:var(--ds-text-title)] font-semibold leading-tight">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-0.5 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div
        className={cn(
          "min-w-0 max-w-full",
          !unstyled && "px-4 pb-5 sm:px-5",
          !unstyled && !(title || actions) && "pt-4 sm:pt-5",
          contentClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}
