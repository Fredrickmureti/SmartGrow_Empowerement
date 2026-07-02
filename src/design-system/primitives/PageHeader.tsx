/**
 * PageHeader — the single approved way to title a page.
 *
 * Slots: title, optional eyebrow, optional description, optional
 * tab strip (peer views of the same record only), and primary/secondary
 * actions on the right.
 *
 * If a module wants its own bespoke header markup, they are doing
 * something wrong. File a ticket; do not bypass.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  /** Tiny pre-title label, e.g. "Employee" or "Q3 Report". */
  eyebrow?: ReactNode;
  /** Required page title. Renders as <h1>. */
  title: ReactNode;
  /** Single-line description below the title. Keep <120 chars. */
  description?: ReactNode;
  /** Primary + secondary action buttons, right-aligned. */
  actions?: ReactNode;
  /** Tab strip for peer views (Profile · Documents · History). */
  tabs?: ReactNode;
  className?: string;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  tabs,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "border-b bg-background px-1 pb-3 pt-5 sm:px-6",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-4">
        <div className="min-w-0">
          {eyebrow && (
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {eyebrow}
            </p>
          )}
          <h1 className="text-[length:var(--ds-text-display)] font-semibold leading-tight break-words sm:truncate">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>
        )}
      </div>
      {tabs && <div className="-mb-3 mt-3">{tabs}</div>}
    </header>
  );
}
