/**
 * KpiRibbon / KpiTile — the scalar band that answers "how are we doing"
 * before any chart is read. Answer-first hierarchy: one row of numbers,
 * each with a tone, an optional delta and an optional sparkline.
 */
import type { ReactNode } from "react";
import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { Link } from "react-router-dom";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { TONE_TEXT, type DashboardTone } from "./tones";
import { useDashboard } from "./context";

export interface KpiTileProps {
  label: ReactNode;
  value: ReactNode;
  unit?: string;
  /** Signed change vs. the previous period. */
  delta?: number;
  /** Whether a rising delta is good. Default true. */
  higherIsBetter?: boolean;
  tone?: DashboardTone;
  hint?: ReactNode;
  /** Series for the sparkline; plain numbers. */
  series?: number[];
  to?: string;
  loading?: boolean;
}

function DeltaBadge({
  delta,
  higherIsBetter = true,
}: {
  delta: number;
  higherIsBetter?: boolean;
}) {
  const flat = Math.abs(delta) < 0.005;
  const good = flat ? null : delta > 0 === higherIsBetter;
  const Icon = flat ? Minus : delta > 0 ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[length:var(--ds-text-micro)] font-semibold",
        good === null
          ? "text-muted-foreground"
          : good
            ? "text-success"
            : "text-destructive",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {flat ? "0%" : `${delta > 0 ? "+" : ""}${Math.round(delta * 100)}%`}
    </span>
  );
}

export function KpiTile({
  label,
  value,
  unit,
  delta,
  higherIsBetter,
  tone = "neutral",
  hint,
  series,
  to,
  loading,
}: KpiTileProps) {
  const { density } = useDashboard();
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[length:var(--ds-text-caption)] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {delta !== undefined && (
          <DeltaBadge delta={delta} higherIsBetter={higherIsBetter} />
        )}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-16 rounded-md" />
      ) : (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
          <span
            className={cn(
              "font-semibold leading-none tabular-nums",
              density === "compact" ? "text-xl" : "text-2xl",
              TONE_TEXT[tone],
            )}
          >
            {value}
          </span>
          {unit && (
            <span className="text-[length:var(--ds-text-caption)] text-muted-foreground">
              {unit}
            </span>
          )}
        </div>
      )}
      {hint && (
        <p className="mt-1 text-[length:var(--ds-text-micro)] leading-snug text-muted-foreground">
          {hint}
        </p>
      )}
      {series && series.length > 1 && (
        <div className="mt-2 h-8 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series.map((v, i) => ({ i, v }))}>
              <Line
                type="monotone"
                dataKey="v"
                stroke="currentColor"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                className={TONE_TEXT[tone]}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  );

  const shell = cn(
    "min-w-0 rounded-[var(--ds-radius-md)] border bg-card",
    density === "compact" ? "px-3 py-2.5" : "px-4 py-3",
  );

  return to ? (
    <Link
      to={to}
      className={cn(
        shell,
        "block transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

interface KpiRibbonProps {
  items: KpiTileProps[];
  className?: string;
  /** Accessible name for the ribbon list. */
  label?: string;
}

export function KpiRibbon({ items, className, label = "Key metrics" }: KpiRibbonProps) {
  return (
    <ul
      aria-label={label}
      className={cn(
        "grid min-w-0 max-w-full gap-[var(--ds-dashboard-gap)]",
        "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]",
        className,
      )}
    >
      {items.map((item, i) => (
        <li key={i} className="min-w-0">
          <KpiTile {...item} />
        </li>
      ))}
    </ul>
  );
}
