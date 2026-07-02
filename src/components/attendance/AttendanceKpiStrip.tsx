/**
 * AttendanceKpiStrip — the four headline figures for the Today view.
 *
 * Tiles are interactive when `value` + `onChange` are supplied: clicking
 * a tile toggles a roster filter. "Checked in now" supports a separate
 * `onPresenceClick` for the live-presence popover.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, LogIn, Plane, UserCheck, UserX } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RosterFilter } from "./StatusFilterChips";

export interface AttendanceKpiStripProps {
  checkedInNow: number;
  totalEmployees: number;
  present: number;
  late: number;
  absent: number;
  onLeave?: number;
  value?: RosterFilter;
  onChange?: (next: RosterFilter) => void;
  onPresenceClick?: () => void;
}

interface Tile {
  key: RosterFilter | "presence";
  label: string;
  value: number;
  hint?: string;
  icon: typeof LogIn;
  tone: "emerald" | "amber" | "rose" | "violet";
}

const tone: Record<Tile["tone"], { text: string; ring: string }> = {
  emerald: { text: "text-emerald-600 dark:text-emerald-400", ring: "ring-emerald-500" },
  amber: { text: "text-amber-600 dark:text-amber-400", ring: "ring-amber-500" },
  rose: { text: "text-rose-600 dark:text-rose-400", ring: "ring-rose-500" },
  violet: { text: "text-violet-600 dark:text-violet-400", ring: "ring-violet-500" },
};

export function AttendanceKpiStrip(props: AttendanceKpiStripProps) {
  const tiles: Tile[] = [
    {
      key: "presence",
      label: "Checked in now",
      value: props.checkedInNow,
      hint: props.totalEmployees ? `of ${props.totalEmployees}` : undefined,
      icon: LogIn,
      tone: "emerald",
    },
    { key: "present", label: "Present", value: props.present, icon: UserCheck, tone: "emerald" },
    { key: "late", label: "Late", value: props.late, icon: AlertTriangle, tone: "amber" },
    { key: "absent", label: "Absent", value: props.absent, icon: UserX, tone: "rose" },
    ...(typeof props.onLeave === "number"
      ? [{ key: "on_leave" as RosterFilter, label: "On leave", value: props.onLeave, icon: Plane, tone: "violet" as const }]
      : []),
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
      {tiles.map((t) => {
        const Icon = t.icon;
        const interactive =
          (t.key === "presence" && props.onPresenceClick) ||
          (t.key !== "presence" && props.onChange);
        const active = t.key !== "presence" && props.value === t.key;
        const handleClick = () => {
          if (t.key === "presence") props.onPresenceClick?.();
          else props.onChange?.(active ? "all" : (t.key as RosterFilter));
        };
        return (
          <Card
            key={t.label}
            onClick={interactive ? handleClick : undefined}
            className={cn(
              interactive && "cursor-pointer hover:border-foreground/20 transition-colors",
              active && `ring-2 ${tone[t.tone].ring}`,
            )}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-xs font-medium text-muted-foreground">{t.label}</CardTitle>
              <Icon className={cn("h-3.5 w-3.5", tone[t.tone].text)} />
            </CardHeader>
            <CardContent className="pb-3">
              <div className="text-2xl font-semibold tabular-nums">{t.value}</div>
              {t.hint && <p className="text-[11px] text-muted-foreground mt-0.5">{t.hint}</p>}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
