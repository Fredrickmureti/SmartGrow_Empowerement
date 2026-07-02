/**
 * Business-timezone-aware date helpers.
 *
 * The HR/attendance backend stamps `attendance_date` (and other "business day"
 * boundaries) using the business's configured timezone, falling back to UTC.
 * Frontend filters MUST resolve "today" / "this week" / "this month" in the
 * SAME zone, otherwise a clock-in late at night in business-local time gets
 * stamped against yesterday's date while the dashboard queries today's date
 * (or vice-versa), and the row disappears.
 *
 * `Intl.DateTimeFormat('en-CA', { timeZone })` returns `YYYY-MM-DD` directly
 * in the target zone — no external dep required.
 */

const ymdFormatter = (timeZone?: string | null) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

/**
 * Format a Date as `YYYY-MM-DD` in the given timezone.
 * Falls back to the browser's local zone when `timeZone` is null/undefined.
 */
export function formatYmdInTz(date: Date, timeZone?: string | null): string {
  try {
    return ymdFormatter(timeZone).format(date);
  } catch {
    // Invalid/unknown timezone — degrade to browser local.
    return ymdFormatter(undefined).format(date);
  }
}

/** Today as `YYYY-MM-DD` in the business timezone. */
export function todayInBusinessTz(timeZone?: string | null): string {
  return formatYmdInTz(new Date(), timeZone);
}

/**
 * Parse a `YYYY-MM-DD` produced by `formatYmdInTz` back into a Date positioned
 * at local-noon of that calendar day, suitable for feeding into date-fns
 * helpers like `startOfWeek` / `startOfMonth` without DST/midnight surprises.
 */
export function ymdToLocalNoon(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
}
