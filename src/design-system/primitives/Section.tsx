/**
 * Section — a titled card-style container for a single chunk of page content
 * (a table, a chart, a form sub-section). Replaces ad-hoc <Card> + <h2>
 * markup across modules.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionProps {
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
      className={cn(
        !unstyled &&
          "rounded-[var(--ds-radius-lg)] border bg-card shadow-[var(--ds-elevation-1)]",
        className,
      )}
    >
      {(title || actions) && (
        <header
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-5 pt-4",
            !unstyled && "pb-3",
          )}
        >
          <div className="min-w-0">
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
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className={cn(!unstyled && "px-5 pb-5", contentClassName)}>
        {children}
      </div>
    </section>
  );
}
