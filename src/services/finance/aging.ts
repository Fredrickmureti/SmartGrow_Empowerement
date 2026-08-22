/**
 * Canonical AR/AP aging vocabulary.
 *
 * There is exactly ONE bucket boundary definition in the product and it lives
 * in SQL (`get_ar_ap_aging_from_ledger` / `get_ar_summary` / `get_ap_summary`):
 *
 *   not_due  : due date in the future        (days_overdue < 0)
 *   current  : 0..30 days past due
 *   days30   : 31..60 days past due
 *   days60   : 61..90 days past due
 *   days90   : 90+ days past due
 *
 * `bucketForDaysOverdue` below mirrors that SQL exactly and is the only
 * client-side implementation permitted. Never re-derive boundaries inline —
 * divergent copies are how "AR total" stops matching "aging total".
 *
 * Unapplied customer credit (`customer_credit_balances`) is part of the net
 * receivable position. It carries a NEGATIVE residual and is never aged: it
 * always lands in `current`.
 */

export type AgingBucketKey = "not_due" | "current" | "days30" | "days60" | "days90";

export const AGING_BUCKET_KEYS: AgingBucketKey[] = [
  "not_due",
  "current",
  "days30",
  "days60",
  "days90",
];

/** Display labels — these MUST describe the SQL boundaries above. */
export const AGING_BUCKET_LABELS: Record<AgingBucketKey, string> = {
  not_due: "Not yet due",
  current: "0–30 days",
  days30: "31–60 days",
  days60: "61–90 days",
  days90: "90+ days",
};

/** Short labels for dense tables/charts. */
export const AGING_BUCKET_SHORT_LABELS: Record<AgingBucketKey, string> = {
  not_due: "Not due",
  current: "0–30",
  days30: "31–60",
  days60: "61–90",
  days90: "90+",
};

/**
 * ADR 0136: `unconvertible_document_count` reports how many open items were
 * EXCLUDED from the buckets because they are denominated in a currency with no
 * exchange rate on file. The buckets are therefore incomplete, not wrong — the
 * surface must say so rather than present the total as final.
 */
export type AgingBuckets = Record<AgingBucketKey, number> & {
  total: number;
  unconvertible_document_count: number;
};

export const EMPTY_AGING_BUCKETS: AgingBuckets = {
  not_due: 0,
  current: 0,
  days30: 0,
  days60: 0,
  days90: 0,
  total: 0,
  unconvertible_document_count: 0,
};

export function emptyAgingBuckets(): AgingBuckets {
  return { ...EMPTY_AGING_BUCKETS };
}

/**
 * Mirror of the SQL bucket CASE expression. `residual` is required because
 * credit positions (negative residual) are never aged.
 */
export function bucketForDaysOverdue(daysOverdue: number, residual = 1): AgingBucketKey {
  if (residual < 0) return "current";
  if (daysOverdue < 0) return "not_due";
  if (daysOverdue <= 30) return "current";
  if (daysOverdue <= 60) return "days30";
  if (daysOverdue <= 90) return "days60";
  return "days90";
}

/** Whole days between a due date and the as-of date (UTC-safe, no time drift). */
export function daysOverdueFrom(dueDate: string | null | undefined, asOf: Date = new Date()): number {
  if (!dueDate) return 0;
  const due = Date.UTC(
    Number(dueDate.slice(0, 4)),
    Number(dueDate.slice(5, 7)) - 1,
    Number(dueDate.slice(8, 10)),
  );
  const ref = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  return Math.floor((ref - due) / 86_400_000);
}

export function addToAgingBuckets(
  buckets: AgingBuckets,
  residual: number,
  daysOverdue: number,
): AgingBuckets {
  if (Math.abs(residual) <= 0.005) return buckets;
  const key = bucketForDaysOverdue(daysOverdue, residual);
  buckets[key] += residual;
  buckets.total += residual;
  return buckets;
}
