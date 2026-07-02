/**
 * RecordShell — the ONLY approved skeleton for a business-record object
 * page (Invoice, PO, Product, Employee, Transfer, …).
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ <RecordHeader>              (sticky, actions right)         │
 *   ├─────────────────────────────────────────────┬──────────────┤
 *   │  main body (SectionCard + FieldGrid)         │  SummaryPanel│
 *   │                                              │  (optional)  │
 *   ├──────────────────────────────────────────────┴──────────────┤
 *   │ <FooterActionBar>            (sticky, anchor="page")         │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Modules pass in the header, main content, optional aside, optional
 * footer. The shell owns spacing, max width, and scroll behavior.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface RecordShellProps {
  /** RecordHeader instance. Required. */
  header: ReactNode;
  /** Main body — usually a stack of SectionCard blocks. */
  children: ReactNode;
  /** Optional right rail (SummaryPanel). Drops below on <lg screens. */
  aside?: ReactNode;
  /** Optional sticky footer (FooterActionBar). */
  footer?: ReactNode;
  className?: string;
}

export function RecordShell({
  header,
  children,
  aside,
  footer,
  className,
}: RecordShellProps) {
  return (
    <div className={cn("w-full", footer && "pb-24", className)}>
      {header}
      <div className="mx-auto w-full max-w-[var(--ds-page-max-width)] px-1 py-6 sm:px-6">
        <div
          className={cn(
            "grid gap-6",
            aside
              ? "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]"
              : "grid-cols-1",
          )}
        >
          <div className="min-w-0 space-y-6">{children}</div>
          {aside && <aside className="space-y-4">{aside}</aside>}
        </div>
      </div>
      {footer}
    </div>
  );
}