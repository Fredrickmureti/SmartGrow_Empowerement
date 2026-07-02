/**
 * KpiStrip — generic 4-6 tile KPI strip used across the HR modules
 * (Attendance, Timesheets, Time-off, Employees).
 *
 * Stateless. The host passes tiles with a label, value, tone, icon and an
 * optional `onClick` (the strip renders the tile as a button when clickable).
 * A single tile may be `active` to indicate it's currently driving a filter
 * on the page below.
 *
 * Pulled out so each module ships the same visual language without copying
 * the bespoke AttendanceKpiStrip styling, which would entrench drift.
 */
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type KpiTone = "neutral" | "emerald" | "amber" | "rose" | "sky";

export interface KpiTile {
  key: string;
  label: string;
  value: number | string;
  hint?: string;
  icon: LucideIcon;
  tone?: KpiTone;
  active?: boolean;
  onClick?: () => void;
}

const TONE: Record<KpiTone, { text: string; ring: string }> = {
  neutral: { text: "text-foreground", ring: "ring-foreground/40" },
  emerald: { text: "text-emerald-600 dark:text-emerald-400", ring: "ring-emerald-500" },
  amber: { text: "text-amber-600 dark:text-amber-400", ring: "ring-amber-500" },
  rose: { text: "text-rose-600 dark:text-rose-400", ring: "ring-rose-500" },
  sky: { text: "text-sky-600 dark:text-sky-400", ring: "ring-sky-500" },
};

export interface KpiStripProps {
  tiles: KpiTile[];
  /** Optional extra class for the grid container — e.g. lg:grid-cols-5. */
  className?: string;
}

export function KpiStrip({ tiles, className }: KpiStripProps) {
  const cols = Math.min(Math.max(tiles.length, 2), 6);
  const gridCols: Record<number, string> = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    5: "sm:grid-cols-3 lg:grid-cols-5",
    6: "sm:grid-cols-3 lg:grid-cols-6",
  };
  return (
    <div className={cn("grid grid-cols-2 gap-2 sm:gap-3", gridCols[cols], className)}>
      {tiles.map((t) => {
        const tone = TONE[t.tone ?? "neutral"];
        const interactive = !!t.onClick;
        const body = (
          <CardContent className="p-3 pt-1">
            <div className={cn("text-2xl font-semibold tabular-nums", tone.text)}>{t.value}</div>
            {t.hint ? <div className="text-[11px] text-muted-foreground mt-0.5">{t.hint}</div> : null}
          </CardContent>
        );
        const head = (
          <CardHeader className="p-3 pb-1 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-xs font-medium text-muted-foreground truncate">{t.label}</CardTitle>
            <t.icon className={cn("h-3.5 w-3.5", tone.text)} />
          </CardHeader>
        );
        const className = cn(
          "transition-shadow",
          interactive && "cursor-pointer hover:shadow-sm",
          t.active && `ring-2 ${tone.ring}`,
        );
        if (interactive) {
          return (
            <button
              key={t.key}
              type="button"
              onClick={t.onClick}
              className="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
            >
              <Card className={className}>
                {head}
                {body}
              </Card>
            </button>
          );
        }
        return (
          <Card key={t.key} className={className}>
            {head}
            {body}
          </Card>
        );
      })}
    </div>
  );
}
