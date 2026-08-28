/**
 * Canonical KPI/summary card used by Finance → Receivables / Payables.
 *
 * This is the ONE stat card for ledger-style summary strips. Purchases
 * (Overview, Purchase orders, Returns, Statements) render the exact same
 * primitive so the cards, typography, spacing and responsive behaviour are
 * identical to AR/AP. Do not re-author a bespoke `<Card>` stat block.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type SummaryStatTone =
  | "default"
  | "primary"
  | "emerald"
  | "yellow"
  | "amber"
  | "orange"
  | "blue"
  | "purple"
  | "destructive";

const TONE_VALUE: Record<SummaryStatTone, string> = {
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

const TONE_ACCENT: Record<SummaryStatTone, string> = {
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

/** Fluid grid used above AR/AP tables: wraps instead of squashing values. */
export function SummaryStatGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]",
        className,
      )}
    >
      {children}
    </div>
  );
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
  onClick?: () => void;
  className?: string;
}

export function SummaryStatCard({
  label,
  value,
  footer,
  icon,
  tone = "default",
  accent = false,
  onClick,
  className,
}: SummaryStatCardProps) {
  return (
    <Card
      onClick={onClick}
      className={cn(
        accent && TONE_ACCENT[tone],
        onClick && "cursor-pointer transition-shadow hover:shadow-md",
        className,
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "stat-value whitespace-nowrap tabular-nums",
            TONE_VALUE[tone],
          )}
        >
          {value}
        </div>
        {footer ? (
          <p className="mt-1 text-xs text-muted-foreground">{footer}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
