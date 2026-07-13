/**
 * Workflow Sheet — design-system primitive for enterprise creation/edit
 * workflows across HR & Payroll (and beyond).
 *
 * Extracted from the redesigned "New Payroll Run" experience. Use instead
 * of `<Dialog>` for any multi-section creation flow. Composition:
 *
 *   <WorkflowSheet open onOpenChange title="…" description="…"
 *                  footer={<>…</>}>
 *     <WorkflowSheetGrid>
 *       <WorkflowSheetSection number={1} title="…">…</WorkflowSheetSection>
 *       <WorkflowSheetSection number={2} title="…">…</WorkflowSheetSection>
 *     </WorkflowSheetGrid>
 *     <WorkflowSheetSection number={3} title="…" fullWidth>…</WorkflowSheetSection>
 *   </WorkflowSheet>
 */
import type { ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type WorkflowSheetSize = "md" | "lg" | "xl" | "2xl" | "full";

const SIZE_CLASSES: Record<WorkflowSheetSize, string> = {
  md: "w-full sm:!max-w-2xl",
  lg: "w-full sm:!max-w-3xl",
  xl: "w-full sm:!max-w-4xl",
  "2xl": "w-full sm:!max-w-5xl",
  // Full-viewport surface for design-driven editors (certificate WYSIWYG,
  // return templates) — a right-side drawer split three ways is not an
  // acceptable UX for statutory documents. Mimics a dedicated page.
  full: "w-screen !max-w-none sm:!max-w-none",
};

export interface WorkflowSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned header slot (status pill, "Draft saved", etc.) */
  headerRight?: ReactNode;
  /** Banner rendered above the body — alerts, conflicts, context badges. */
  banner?: ReactNode;
  /** Sticky footer; place action buttons here. */
  footer?: ReactNode;
  /** Wrap body in a `<form>` and forward submission. */
  onSubmit?: (e: React.FormEvent) => void;
  size?: WorkflowSheetSize;
  /** Block outside-click / Esc — used as a dirty-guard. */
  preventAutoClose?: boolean;
  onAutoCloseAttempt?: () => void;
  children: ReactNode;
  contentClassName?: string;
}

export function WorkflowSheet({
  open,
  onOpenChange,
  title,
  description,
  headerRight,
  banner,
  footer,
  onSubmit,
  size = "2xl",
  preventAutoClose,
  onAutoCloseAttempt,
  children,
  contentClassName,
}: WorkflowSheetProps) {
  const Body: any = onSubmit ? "form" : "div";
  const bodyProps = onSubmit ? { onSubmit } : {};

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          SIZE_CLASSES[size],
          "p-0 flex flex-col overflow-hidden",
          contentClassName,
        )}
        onInteractOutside={(e) => {
          if (preventAutoClose) {
            e.preventDefault();
            onAutoCloseAttempt?.();
          }
        }}
        onEscapeKeyDown={(e) => {
          if (preventAutoClose) {
            e.preventDefault();
            onAutoCloseAttempt?.();
          }
        }}
      >
        <SheetHeader className="px-5 py-4 border-b shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SheetTitle className="text-base sm:text-lg">{title}</SheetTitle>
              {description && (
                <SheetDescription className="text-xs sm:text-sm mt-0.5">
                  {description}
                </SheetDescription>
              )}
            </div>
            {headerRight && <div className="shrink-0">{headerRight}</div>}
          </div>
        </SheetHeader>

        <Body {...bodyProps} className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto">
            <div className="px-4 sm:px-5 py-4 space-y-4">
              {banner}
              {children}
            </div>
          </div>
          {footer && (
            <div className="shrink-0 border-t bg-card/60 backdrop-blur supports-[backdrop-filter]:bg-card/40">
              <div className="px-4 sm:px-5 py-3 flex flex-wrap items-center justify-end gap-2">
                {footer}
              </div>
            </div>
          )}
        </Body>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Two-column responsive grid for sections. Collapses to a single column
 * below `lg`. Place full-width sections outside the grid (or use the
 * `fullWidth` flag on `WorkflowSheetSection` when inside the grid).
 */
export function WorkflowSheetGrid({
  children,
  className,
  columns = 2,
}: {
  children: ReactNode;
  className?: string;
  columns?: 2 | 3 | 4;
}) {
  const colClass =
    columns === 2
      ? "lg:grid-cols-2"
      : columns === 3
        ? "lg:grid-cols-3"
        : "lg:grid-cols-2 xl:grid-cols-4";
  return (
    <div
      className={cn("grid grid-cols-1 gap-4", colClass, className)}
    >
      {children}
    </div>
  );
}

/**
 * Numbered panel section. Numbered chip + title + optional subtitle, with
 * a right-aligned slot for inline actions.
 */
export function WorkflowSheetSection({
  number,
  title,
  subtitle,
  right,
  children,
  className,
  fullWidth,
  id,
}: {
  number?: number;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  fullWidth?: boolean;
  id?: string;
}) {
  const headingId =
    id ??
    `wf-section-${
      typeof title === "string"
        ? title.toLowerCase().replace(/\s+/g, "-")
        : Math.random().toString(36).slice(2)
    }`;
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "rounded-lg border bg-card",
        fullWidth && "lg:col-span-2",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-3 pb-2 border-b">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {number !== undefined && (
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                {number}
              </span>
            )}
            <h3 id={headingId} className="text-sm font-semibold">
              {title}
            </h3>
          </div>
          {subtitle && (
            <p
              className={cn(
                "text-[11px] text-muted-foreground mt-0.5",
                number !== undefined && "ml-7",
              )}
            >
              {subtitle}
            </p>
          )}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      <div className="p-4 space-y-3">{children}</div>
    </section>
  );
}

/**
 * Labelled field column intended to sit inside a `WorkflowSheetSection`.
 */
export function WorkflowField({
  label,
  htmlFor,
  hint,
  required,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="text-xs sm:text-sm font-medium leading-none"
      >
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
