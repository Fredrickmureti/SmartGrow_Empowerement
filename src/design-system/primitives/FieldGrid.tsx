/**
 * FieldGrid — the single approved responsive grid for form fields.
 *
 * Responsive contract:
 *   base (mobile):  1 column
 *   sm (≥640px):    2 columns
 *   lg (≥1024px):   3 columns
 *   xl (≥1280px):   up to `columns` columns (default 3, max 4)
 *
 * Children can opt into wider spans with the sibling <FieldCell span="…" />
 * wrapper. Anything wider than a single cell should use `span="full"`.
 *
 * Modules MUST NOT hand-roll `grid grid-cols-…` for form fields — that is
 * exactly the drift this primitive exists to prevent.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FieldGridProps {
  children: ReactNode;
  /** Max desktop columns (2–4). Default 3. */
  columns?: 2 | 3 | 4;
  className?: string;
}

const colsClass: Record<2 | 3 | 4, string> = {
  2: "sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
};

export function FieldGrid({ children, columns = 3, className }: FieldGridProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-x-4 gap-y-4",
        colsClass[columns],
        className,
      )}
    >
      {children}
    </div>
  );
}

interface FieldCellProps {
  children: ReactNode;
  /** Cell span. "full" spans the whole row on every breakpoint. */
  span?: 1 | 2 | 3 | 4 | "full";
  className?: string;
}

const spanClass: Record<NonNullable<FieldCellProps["span"]>, string> = {
  1: "",
  2: "sm:col-span-2",
  3: "lg:col-span-3",
  4: "xl:col-span-4",
  full: "col-span-full",
};

export function FieldCell({ children, span = 1, className }: FieldCellProps) {
  return (
    <div className={cn("min-w-0", spanClass[span], className)}>{children}</div>
  );
}

interface FieldGroupProps {
  /** Group label, e.g. "Address" or "Tax". Optional. */
  label?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * FieldGroup — a labeled sub-block inside a Section. Use for logically
 * related fields (address block, tax block, dates block). Does not draw
 * its own card; it lives inside a Section/SectionCard.
 */
export function FieldGroup({
  label,
  description,
  children,
  className,
}: FieldGroupProps) {
  return (
    <div className={cn("space-y-3", className)}>
      {(label || description) && (
        <div>
          {label && (
            <h3 className="text-[length:var(--ds-text-heading)] font-semibold leading-tight">
              {label}
            </h3>
          )}
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      )}
      {children}
    </div>
  );
}