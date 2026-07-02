/**
 * StatusFilterChips — single-select chip strip used in HR list/grid pages
 * (Roster, etc.). Behaves like a horizontal segmented control: clicking an
 * already-active chip clears it; clicking another chip switches selection.
 *
 * Generic over the chip value so callers stay typed.
 */
import { cn } from "@/lib/utils";

export interface StatusChip<T extends string> {
  value: T;
  label: string;
  /** Optional count rendered as a small pill alongside the label. */
  count?: number;
  /** Optional tailwind tint applied when the chip is active. */
  tone?: "default" | "amber" | "emerald" | "rose" | "indigo";
}

interface Props<T extends string> {
  chips: StatusChip<T>[];
  active: T | null;
  onChange: (next: T | null) => void;
  className?: string;
}

const TONE: Record<NonNullable<StatusChip<string>["tone"]>, string> = {
  default: "bg-primary/10 text-primary border-primary/30",
  amber:
    "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/40 dark:text-amber-100 dark:border-amber-700/60",
  emerald:
    "bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-100 dark:border-emerald-700/60",
  rose:
    "bg-rose-100 text-rose-900 border-rose-300 dark:bg-rose-900/40 dark:text-rose-100 dark:border-rose-700/60",
  indigo:
    "bg-indigo-100 text-indigo-900 border-indigo-300 dark:bg-indigo-900/40 dark:text-indigo-100 dark:border-indigo-700/60",
};

export function StatusFilterChips<T extends string>({
  chips,
  active,
  onChange,
  className,
}: Props<T>) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {chips.map((chip) => {
        const isActive = active === chip.value;
        const tone = TONE[chip.tone ?? "default"];
        return (
          <button
            key={chip.value}
            type="button"
            onClick={() => onChange(isActive ? null : chip.value)}
            aria-pressed={isActive}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              isActive
                ? tone
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            <span>{chip.label}</span>
            {typeof chip.count === "number" && (
              <span
                className={cn(
                  "inline-flex items-center justify-center rounded-full px-1.5 text-[10px] leading-none min-w-[18px] h-[18px]",
                  isActive
                    ? "bg-background/40 text-current"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {chip.count > 999 ? "999+" : chip.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default StatusFilterChips;
