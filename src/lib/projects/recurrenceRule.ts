/**
 * Recurrence rule helpers — pure, used by the `generate-recurring-tasks`
 * edge function (Deno) and unit-tested here under vitest. Keep the body of
 * `nextDate` byte-identical with the copy in
 * `supabase/functions/generate-recurring-tasks/index.ts` — the architecture
 * test `recurring-tasks-rule-parity.test.ts` enforces this.
 */

export interface RecurrenceRule {
  freq?: "daily" | "weekly" | "monthly";
  interval?: number;
  /** Inclusive end date "YYYY-MM-DD". Past this date, no more occurrences. */
  until?: string;
}

export function nextDate(from: string, rule: RecurrenceRule): string {
  const d = new Date(from + "T00:00:00Z");
  const i = Math.max(1, rule.interval ?? 1);
  switch (rule.freq) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7 * i);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + i);
      break;
    case "daily":
    default:
      d.setUTCDate(d.getUTCDate() + i);
  }
  return d.toISOString().slice(0, 10);
}

/** True when `due` is past the rule's `until` cutoff (rule expired). */
export function isExpired(due: string, rule: RecurrenceRule): boolean {
  return Boolean(rule.until && due > rule.until);
}