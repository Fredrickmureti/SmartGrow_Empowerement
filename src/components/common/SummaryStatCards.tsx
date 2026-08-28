/**
 * Canonical KPI/summary card for the whole ERP.
 *
 * This is the ONE stat card for summary strips — Finance (Receivables /
 * Payables), Sales, Purchases, Inventory, Reports and Warehouse all render
 * this exact primitive so the cards, typography, spacing, drill-down and
 * responsive behaviour are identical everywhere. Do NOT re-author a bespoke
 * `<Card>` stat block, and do NOT create a module-prefixed variant
 * (`WarehouseKpiCard`, `SalesStatCard`, …). If a module need cannot be
 * expressed here, extend this file so every module inherits the capability.
 *
 * Responsive model: `SummaryStatGrid` is **container-query driven**. It sizes
 * itself against its own width, not the viewport, so a strip inside a narrow
 * two-column workspace reflows exactly like a strip on a full-width page.
 *
 * Also re-exported from `@/design-system`.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export type SummaryStatTone =
  | "default"
  | "primary"
  | "emerald"
  | "yellow"
  | "amber"
  | "orange"
  | "blue"
  | "purple"
  | "destructive"
  /* Operational aliases (WMS/ops semantics) mapped onto the same values —
     deliberately NOT a second tone scale. */
  | "ok"
  | "warn"
  | "bad"
  | "neutral";

/** Operational aliases resolve to the canonical tone before lookup. */
function resolveTone(tone: SummaryStatTone): Exclude<
  SummaryStatTone,
  "ok" | "warn" | "bad" | "neutral"
> {
  switch (tone) {
    case "ok":
      return "emerald";
    case "warn":
      return "amber";
    case "bad":
      return "destructive";
    case "neutral":
      return "default";
    default:
      return tone;
  }
}

type CanonicalTone = ReturnType<typeof resolveTone>;

const TONE_VALUE: Record<CanonicalTone, string> = {
  default: "",
  primary: "text-primary",
  emerald: "text-emerald-600",
  yellow: "text-yellow-600",
  amber: "text-amber-600",
  orange: "text-orange-600",
  blue: "text-blue-600",
  purple: "text-purple-600",
  destructive: "text-destructive",
};

const TONE_ACCENT: Record<CanonicalTone, string> = {
  default: "border-l-4 border-l-border",
  primary: "border-l-4 border-l-primary",
  emerald: "border-l-4 border-l-emerald-500",
  yellow: "border-l-4 border-l-yellow-400",
  amber: "border-l-4 border-l-amber-400",
  orange: "border-l-4 border-l-orange-500",
  blue: "border-l-4 border-l-blue-500",
  purple: "border-l-4 border-l-purple-500",
  destructive: "border-l-4 border-l-destructive",
};

/**
 * Fluid grid used above tables and on dashboards: wraps instead of squashing
 * values. Container-query driven (`@container/stats`) with an intrinsic
 * `auto-fit` fallback, so it never depends on the viewport width.
 */
export function SummaryStatGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="@container/stats min-w-0">
      <div
        className={cn(
          "grid min-w-0 gap-3",
          "[grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]",
          "@md/stats:gap-4 @md/stats:[grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]",
          "@3xl/stats:[grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export type SummaryStatTrendDirection = "up" | "down" | "flat";

export interface SummaryStatTrend {
  /** Pre-formatted delta, e.g. "+12%" or "3 more than yesterday". */
  value: ReactNode;
  direction?: SummaryStatTrendDirection;
  /**
   * Whether the direction is good news. Ops metrics invert constantly
   * (rising backlog = bad, rising throughput = good), so the caller decides.
   */
  good?: boolean;
}

export interface SummaryStatCardProps {
  label: string;
  value: ReactNode;
  /** Small caption under the value. */
  footer?: ReactNode;
  /** Optional icon rendered before the label. */
  icon?: ReactNode;
  tone?: SummaryStatTone;
  /** Render the coloured left rule (AR/AP aging buckets use it). */
  accent?: boolean;
  /** Optional badge / status pill rendered on the header's right edge. */
  status?: ReactNode;
  /** Optional trend row under the value. */
  trend?: SummaryStatTrend;
  /** Drill-down destination. Renders the card as a router link. */
  to?: string;
  onClick?: () => void;
  /** Native tooltip (SLA targets, definitions). */
  title?: string;
  /** Skeleton in the card's own shape — never swap the card for a spinner. */
  loading?: boolean;
  className?: string;
}

const TREND_ICON: Record<SummaryStatTrendDirection, typeof ArrowUpRight> = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: ArrowRight,
};

export function SummaryStatCard({
  label,
  value,
  footer,
  icon,
  tone = "default",
  accent = false,
  status,
  trend,
  to,
  onClick,
  loading = false,
  className,
}: SummaryStatCardProps) {
  const canonical = resolveTone(tone);
  const interactive = Boolean(to || onClick);

  const TrendIcon = trend?.direction ? TREND_ICON[trend.direction] : null;
  const trendTone =
    trend?.good === undefined
      ? "text-muted-foreground"
      : trend.good
        ? "text-emerald-600"
        : "text-destructive";

  const card = (
    <Card
      onClick={onClick}
      className={cn(
        "h-full min-w-0",
        accent && TONE_ACCENT[canonical],
        interactive &&
          "cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {icon}
          <span className="min-w-0 truncate">{label}</span>
          {status ? <span className="ml-auto shrink-0">{status}</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <>
            <Skeleton className="h-7 w-24" />
            {footer ? <Skeleton className="mt-2 h-3 w-32" /> : null}
          </>
        ) : (
          <>
            <div
              className={cn(
                "stat-value whitespace-nowrap tabular-nums",
                TONE_VALUE[canonical],
              )}
            >
              {value}
            </div>
            {trend ? (
              <p
                className={cn(
                  "mt-1 flex items-center gap-1 text-xs tabular-nums",
                  trendTone,
                )}
              >
                {TrendIcon ? <TrendIcon className="h-3 w-3 shrink-0" /> : null}
                <span className="min-w-0 truncate">{trend.value}</span>
              </p>
            ) : null}
            {footer ? (
              <p className="mt-1 text-xs text-muted-foreground">{footer}</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );

  if (to && !loading) {
    return (
      <Link to={to} className="block min-w-0 no-underline">
        {card}
      </Link>
    );
  }

  return card;
}
