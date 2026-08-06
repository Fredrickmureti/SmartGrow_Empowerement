/**
 * MetricCard — compact single metric for grid infill (label, value,
 * optional tone + footnote). Use inside a DashboardWidget body when a
 * panel needs a small cluster of numbers.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TONE_TEXT, type DashboardTone } from "./tones";

interface MetricCardProps {
  label: ReactNode;
  value: ReactNode;
  footnote?: ReactNode;
  tone?: DashboardTone;
  className?: string;
}

export function MetricCard({
  label,
  value,
  footnote,
  tone = "neutral",
  className,
}: MetricCardProps) {
  return (
    <div className={cn("min-w-0 rounded-[var(--ds-radius-md)] bg-muted/40 px-3 py-2", className)}>
      <div className="truncate text-[length:var(--ds-text-micro)] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-0.5 text-lg font-semibold tabular-nums leading-none", TONE_TEXT[tone])}>
        {value}
      </div>
      {footnote && (
        <div className="mt-1 truncate text-[length:var(--ds-text-micro)] text-muted-foreground">
          {footnote}
        </div>
      )}
    </div>
  );
}
