/**
 * Locale-aware week-start helper.
 *
 * Reads from a Business row (or any object with `week_starts_on`).
 * Falls back to ISO Monday (1) when the company hasn't been configured.
 *
 * Allowed values match `date-fns`: 0 = Sunday, 1 = Monday, 6 = Saturday.
 */
export type WeekStart = 0 | 1 | 6;

export function getWeekStart(business?: { week_starts_on?: number | null } | null): WeekStart {
  const v = business?.week_starts_on;
  if (v === 0 || v === 1 || v === 6) return v;
  return 1;
}

/** Weekly hours target for the active business. Default 40. */
export function getWeeklyHoursTarget(business?: { weekly_hours_target?: number | null } | null): number {
  const v = business?.weekly_hours_target;
  return typeof v === "number" && v > 0 ? v : 40;
}