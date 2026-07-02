/**
 * StatusFilterChips — segmented filter for attendance rows.
 *
 * Drives both the KPI highlight on the Today page and the roster filter.
 * Stateless: caller owns `value` and `onChange`.
 */
import { cn } from "@/lib/utils";

export type RosterFilter =
  | "all"
  | "present"
  | "late"
  | "absent"
  | "on_leave"
  | "anomaly";

export interface RosterFilterCounts {
  all: number;
  present: number;
  late: number;
  absent: number;
  on_leave: number;
  anomaly: number;
}

const ITEMS: { key: RosterFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "present", label: "Present" },
  { key: "late", label: "Late" },
  { key: "absent", label: "Absent" },
  { key: "on_leave", label: "On leave" },
  { key: "anomaly", label: "Anomalies" },
];

export function StatusFilterChips({
  value,
  onChange,
  counts,
}: {
  value: RosterFilter;
  onChange: (v: RosterFilter) => void;
  counts?: Partial<RosterFilterCounts>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ITEMS.map((item) => {
        const active = value === item.key;
        const c = counts?.[item.key];
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors border",
              active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            {item.label}
            {typeof c === "number" && (
              <span
                className={cn(
                  "tabular-nums text-[10px] rounded-full px-1.5",
                  active ? "bg-primary-foreground/20" : "bg-muted",
                )}
              >
                {c}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
