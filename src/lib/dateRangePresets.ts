/**
 * Canonical date-range presets for ledger / statement style screens.
 *
 * These are pure date helpers: they only translate a preset key into an
 * inclusive [from, to] pair of ISO `yyyy-MM-dd` strings. No data access,
 * no business rules — the consuming page stays a read-only projection.
 */
import {
  endOfMonth,
  endOfYear,
  format,
  startOfMonth,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";

export type DateRangePresetKey =
  | "all"
  | "last_7_days"
  | "last_30_days"
  | "this_month"
  | "last_month"
  | "last_3_months"
  | "this_year"
  | "custom";

export interface DateRangeValue {
  /** ISO yyyy-MM-dd, or "" for open-ended */
  from: string;
  /** ISO yyyy-MM-dd, or "" for open-ended */
  to: string;
}

export const DATE_RANGE_PRESETS: { key: DateRangePresetKey; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "last_7_days", label: "Last 7 days" },
  { key: "last_30_days", label: "Last 30 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_3_months", label: "Last 3 months" },
  { key: "this_year", label: "This year" },
  { key: "custom", label: "Custom" },
];

const iso = (d: Date) => format(d, "yyyy-MM-dd");

export function resolveDateRangePreset(
  key: DateRangePresetKey,
  today: Date = new Date(),
): DateRangeValue {
  switch (key) {
    case "last_7_days":
      return { from: iso(subDays(today, 6)), to: iso(today) };
    case "last_30_days":
      return { from: iso(subDays(today, 29)), to: iso(today) };
    case "this_month":
      return { from: iso(startOfMonth(today)), to: iso(endOfMonth(today)) };
    case "last_month": {
      const prev = subMonths(today, 1);
      return { from: iso(startOfMonth(prev)), to: iso(endOfMonth(prev)) };
    }
    case "last_3_months":
      return { from: iso(startOfMonth(subMonths(today, 2))), to: iso(today) };
    case "this_year":
      return { from: iso(startOfYear(today)), to: iso(endOfYear(today)) };
    case "all":
    case "custom":
    default:
      return { from: "", to: "" };
  }
}

/**
 * Given an explicit range, return the preset key that produces it (so a
 * deep-linked or inherited range still reads back as a named period), or
 * "custom" / "all" when nothing matches.
 */
export function matchDateRangePreset(
  range: DateRangeValue,
  today: Date = new Date(),
): DateRangePresetKey {
  if (!range.from && !range.to) return "all";
  for (const { key } of DATE_RANGE_PRESETS) {
    if (key === "all" || key === "custom") continue;
    const candidate = resolveDateRangePreset(key, today);
    if (candidate.from === range.from && candidate.to === range.to) return key;
  }
  return "custom";
}

/** Human-readable label, e.g. "1 Jan 2026 – 31 Mar 2026" / "All activity to date". */
export function describeDateRange(range: DateRangeValue): string {
  const fmt = (v: string) => {
    const d = new Date(`${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? v : format(d, "d MMM yyyy");
  };
  if (!range.from && !range.to) return "All activity to date";
  if (range.from && !range.to) return `From ${fmt(range.from)}`;
  if (!range.from && range.to) return `Up to ${fmt(range.to)}`;
  return `${fmt(range.from)} – ${fmt(range.to)}`;
}
