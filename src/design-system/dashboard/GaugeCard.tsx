/**
 * GaugeCard — utilisation / capacity with threshold bands. The bar is a
 * pure token-driven meter; tone is derived from the value, never passed
 * as a colour by the caller.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TONE_BAR, TONE_TEXT, utilisationTone, type DashboardTone } from "./tones";

interface GaugeCardProps {
  label: ReactNode;
  /** 0–100. */
  value: number;
  caption?: ReactNode;
  /** Override the derived threshold tone. */
  tone?: DashboardTone;
  className?: string;
}

export function GaugeCard({ label, value, caption, tone, className }: GaugeCardProps) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const resolved = tone ?? utilisationTone(pct);
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[length:var(--ds-text-caption)] text-muted-foreground">
          {label}
        </span>
        <span className={cn("text-sm font-semibold tabular-nums", TONE_TEXT[resolved])}>
          {Math.round(pct)}%
        </span>
      </div>
      <div
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={typeof label === "string" ? label : undefined}
        className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full transition-[width]", TONE_BAR[resolved])}
          style={{ width: `${pct}%` }}
        />
      </div>
      {caption && (
        <p className="mt-1 truncate text-[length:var(--ds-text-micro)] text-muted-foreground">
          {caption}
        </p>
      )}
    </div>
  );
}
