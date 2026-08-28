/**
 * Canonical composite/exception card for the whole ERP.
 *
 * Extracted verbatim from the Finance reference implementation
 * (`ControlAccountReconciliationCard` on Receivables / Payables), which is the
 * pattern the platform already uses for "here is a condition, here is the
 * supporting arithmetic, here is what to do about it":
 *
 *   tone accent rule + tinted surface
 *   icon + title + one-line explanation
 *   status badge on the right
 *   optional row of mini metrics (the numbers that justify the condition)
 *   optional action (drill-down / remediation)
 *
 * Warehouse operational callouts (SLA breach, yard congestion, count variance,
 * dispatch not ready) render this same component so an ops exception reads
 * exactly like a finance exception. Do not re-author the markup.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export type CalloutTone = "neutral" | "info" | "success" | "warning" | "danger";

const SURFACE: Record<CalloutTone, string> = {
  neutral: "",
  info: "border-l-4 border-l-blue-500 bg-blue-500/5",
  success: "border-l-4 border-l-emerald-500 bg-emerald-500/5",
  warning: "border-l-4 border-l-amber-500 bg-amber-500/5",
  danger: "border-l-4 border-l-destructive bg-destructive/5",
};

const ICON_TONE: Record<CalloutTone, string> = {
  neutral: "text-muted-foreground",
  info: "text-blue-600",
  success: "text-emerald-600",
  warning: "text-amber-600",
  danger: "text-destructive",
};

/** A single supporting number inside a callout. */
export interface CalloutMetric {
  label: ReactNode;
  value: ReactNode;
  tone?: CalloutTone;
  /** Span two columns on narrow containers (Finance uses this for "Drift"). */
  wide?: boolean;
}

export interface CalloutCardProps {
  tone?: CalloutTone;
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned badge slot. */
  badge?: ReactNode;
  metrics?: CalloutMetric[];
  /** Drill-down destination (router link). */
  to?: string;
  actionLabel?: ReactNode;
  onAction?: () => void;
  loading?: boolean;
  className?: string;
}

const VALUE_TONE: Record<CalloutTone, string> = {
  neutral: "",
  info: "text-blue-600",
  success: "text-emerald-600",
  warning: "text-amber-600",
  danger: "text-destructive",
};

export function CalloutCard({
  tone = "neutral",
  icon,
  title,
  description,
  badge,
  metrics,
  to,
  actionLabel,
  onAction,
  loading = false,
  className,
}: CalloutCardProps) {
  if (loading) {
    return (
      <Card className={className}>
        <CardContent className="p-4">
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  const hasMetrics = Boolean(metrics?.length);
  const hasAction = Boolean(actionLabel && (to || onAction));

  return (
    <Card className={cn("min-w-0", SURFACE[tone], className)}>
      <CardContent
        className={cn(
          "p-4",
          hasMetrics || hasAction
            ? "space-y-3"
            : "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {icon ? (
              <span className={cn("shrink-0", ICON_TONE[tone])}>{icon}</span>
            ) : null}
            <div className="min-w-0">
              <p className="text-sm font-medium">{title}</p>
              {description ? (
                <p className="text-xs text-muted-foreground">{description}</p>
              ) : null}
            </div>
          </div>
          {badge ? <span className="shrink-0">{badge}</span> : null}
        </div>

        {hasMetrics ? (
          <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
            {metrics!.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "min-w-0 rounded-md border bg-background p-2",
                  m.wide && "col-span-2 sm:col-span-1",
                )}
              >
                <p className="truncate text-muted-foreground">{m.label}</p>
                <p
                  className={cn(
                    "font-semibold tabular-nums",
                    m.tone ? VALUE_TONE[m.tone] : "",
                  )}
                >
                  {m.value}
                </p>
              </div>
            ))}
          </div>
        ) : null}

        {hasAction ? (
          to ? (
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link to={to}>
                {actionLabel}
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onAction}>
              {actionLabel}
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
