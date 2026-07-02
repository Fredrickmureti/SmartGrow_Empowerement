/**
 * RecordHeader — object-page identity band for a business record
 * (Invoice, PO, Product, Employee, …). This is the ONLY approved header
 * for a record route. It supersedes PageHeader on object pages because
 * records carry structured identity (doc number, status, meta chips)
 * that PageHeader is not shaped to hold.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ breadcrumb                                                  │
 *   │ eyebrow                                                     │
 *   │ Title · #DOC-NUMBER · <StatusBadge>       [primary actions] │
 *   │ [meta chip] [meta chip] [meta chip] …                       │
 *   └────────────────────────────────────────────────────────────┘
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface RecordHeaderProps {
  /** Breadcrumb slot — render breadcrumb primitive here. */
  breadcrumb?: ReactNode;
  /** Tiny pre-title label, e.g. "Sales Invoice". */
  eyebrow?: ReactNode;
  /** Record title. Renders as <h1>. */
  title: ReactNode;
  /** Human doc number (e.g. INV-000123). Rendered next to the title. */
  docNumber?: ReactNode;
  /** StatusBadge instance. */
  status?: ReactNode;
  /** Compact meta chips row (customer name, date, branch, amount). */
  meta?: ReactNode;
  /** Right-aligned action cluster (ActionBar). */
  actions?: ReactNode;
  /** Optional peer-view tab strip below the header. */
  tabs?: ReactNode;
  className?: string;
}

export function RecordHeader({
  breadcrumb,
  eyebrow,
  title,
  docNumber,
  status,
  meta,
  actions,
  tabs,
  className,
}: RecordHeaderProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-20 border-b bg-background/95 px-1 pb-3 pt-4 backdrop-blur sm:px-6",
        className,
      )}
    >
      {breadcrumb && <div className="mb-1 text-xs">{breadcrumb}</div>}
      <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-4">
        <div className="min-w-0">
          {eyebrow && (
            <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {eyebrow}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-[length:var(--ds-text-display)] font-semibold leading-tight">
              {title}
            </h1>
            {docNumber && (
              <span className="font-mono text-sm text-muted-foreground">
                {docNumber}
              </span>
            )}
            {status && <span className="shrink-0">{status}</span>}
          </div>
          {meta && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            {actions}
          </div>
        )}
      </div>
      {tabs && <div className="-mb-3 mt-3">{tabs}</div>}
    </header>
  );
}