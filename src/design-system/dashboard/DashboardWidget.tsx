/**
 * DashboardWidget — the ONLY card type on a dashboard.
 *
 * It owns three things pages used to hand-roll, badly:
 *   1. geometry   — via a semantic `span`, resolved by the canvas grid.
 *   2. weight     — via `variant`, so a KPI never reads like a feed.
 *   3. lifecycle  — loading / empty / error / retry, per widget, so one
 *                   slow query can never blank the whole command centre.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { LoadingState } from "../primitives/LoadingState";
import { EmptyState } from "../primitives/EmptyState";
import { ErrorState } from "../primitives/ErrorState";
import { DrillLink } from "./DrillLink";
import { spanClass, type DashboardSpan } from "./spans";
import { useDashboard } from "./context";

export type DashboardWidgetVariant =
  | "kpi"
  | "status"
  | "action"
  | "flow"
  | "list"
  | "feed"
  | "chart"
  | "plain";

/** The minimal slice of a React Query result a widget needs. */
export interface WidgetQuery {
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  refetch?: () => unknown;
}

interface DashboardWidgetProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Small right-aligned meta (counts, timestamps). */
  meta?: ReactNode;
  actions?: ReactNode;
  span?: DashboardSpan;
  variant?: DashboardWidgetVariant;
  /** Route into the owning module. */
  drillTo?: string;
  drillLabel?: string;
  /** Wire a React Query result and the widget handles its own states. */
  query?: WidgetQuery;
  /** Render the empty surface instead of children. */
  isEmpty?: boolean;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  /** Skeleton rows while loading. */
  loadingRows?: number;
  /** Content-height hint; never a fixed pixel height. */
  minRows?: number;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
}

const VARIANT_CLASS: Record<DashboardWidgetVariant, string> = {
  kpi: "bg-card",
  status: "bg-card",
  action: "bg-card ring-1 ring-inset ring-border/60",
  flow: "bg-card",
  list: "bg-card",
  feed: "bg-muted/30",
  chart: "bg-card",
  plain: "bg-transparent border-transparent shadow-none",
};

export function DashboardWidget({
  title,
  description,
  meta,
  actions,
  span = "full",
  variant = "plain",
  drillTo,
  drillLabel = "Open",
  query,
  isEmpty,
  emptyTitle = "Nothing to show",
  emptyDescription,
  loadingRows = 3,
  minRows,
  children,
  className,
  contentClassName,
}: DashboardWidgetProps) {
  const { density } = useDashboard();
  const pad = density === "compact" ? "px-3 py-3" : "px-4 py-4 sm:px-5";

  const status = query?.isError
    ? "error"
    : query?.isLoading
      ? "loading"
      : isEmpty
        ? "empty"
        : "ready";

  return (
    <section
      aria-label={typeof title === "string" ? title : undefined}
      data-widget-variant={variant}
      data-widget-status={status}
      className={cn(
        "flex min-w-0 max-w-full flex-col rounded-[var(--ds-radius-lg)] border shadow-[var(--ds-elevation-1)]",
        VARIANT_CLASS[variant],
        spanClass(span),
        className,
      )}
      style={
        minRows
          ? { minHeight: `calc(${minRows} * var(--ds-row-height))` }
          : undefined
      }
    >
      {(title || actions || meta || drillTo) && (
        <header
          className={cn(
            "flex flex-wrap items-start justify-between gap-x-3 gap-y-1",
            pad,
            "pb-2",
          )}
        >
          <div className="min-w-0 flex-1 basis-[12rem]">
            {title && (
              <h3 className="truncate text-[length:var(--ds-text-heading)] font-semibold leading-tight">
                {title}
              </h3>
            )}
            {description && (
              <p className="mt-0.5 text-[length:var(--ds-text-caption)] text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {meta}
            {actions}
            {drillTo && <DrillLink to={drillTo}>{drillLabel}</DrillLink>}
          </div>
        </header>
      )}

      <div
        className={cn(
          "min-w-0 max-w-full flex-1",
          pad,
          (title || actions || meta || drillTo) && "pt-0",
          contentClassName,
        )}
      >
        {status === "error" ? (
          <ErrorState
            title="Couldn’t load this"
            description={(query?.error as Error)?.message}
            onRetry={query?.refetch ? () => query.refetch?.() : undefined}
          />
        ) : status === "loading" ? (
          <LoadingState rows={loadingRows} />
        ) : status === "empty" ? (
          <EmptyState title={emptyTitle} description={emptyDescription} />
        ) : (
          children
        )}
      </div>
    </section>
  );
}
