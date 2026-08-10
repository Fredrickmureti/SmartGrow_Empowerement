/**
 * Bill status derivation — AP remediation Step 2b.
 *
 * `overdue` is NOT a lifecycle state. It is a condition of an already-posted
 * bill: past its due date with money still outstanding. It used to be written
 * into `bills.status` by the trigger `trg_bill_overdue_check`, which destroyed
 * the real state (received / partial) and went stale as soon as the clock
 * moved past midnight or a payment landed.
 *
 * The trigger is retired. The enum value is kept for back-compat only.
 * Everything that needs to *show* overdue derives it here.
 */

/** Minimal shape needed to decide overdue-ness. */
export interface BillOverdueInput {
  status: string;
  due_date: string;
  total: number;
  amount_paid?: number | null;
}

/** Lifecycle states that can carry an outstanding AP balance. */
const OPEN_STATUSES = new Set(["received", "partial", "overdue"]);

/** Outstanding balance in bill currency. */
export function billBalance(bill: BillOverdueInput): number {
  return Number(bill.total ?? 0) - Number(bill.amount_paid ?? 0);
}

/** Local-midnight `YYYY-MM-DD` so comparisons match the user's calendar day. */
function today(): string {
  const now = new Date();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * True when a posted bill is past due with a balance remaining.
 * Rounded to cents so float dust never marks a settled bill overdue.
 */
export function isBillOverdue(bill: BillOverdueInput, asOf: string = today()): boolean {
  if (!OPEN_STATUSES.has(bill.status)) return false;
  if (Math.round(billBalance(bill) * 100) <= 0) return false;
  return (bill.due_date ?? "") < asOf;
}

/**
 * Status to *display*. Never persist this — it is a projection.
 * Legacy rows still stamped `overdue` are normalised back onto their real
 * state before the overdue condition is re-applied.
 */
export function deriveBillStatus(bill: BillOverdueInput, asOf: string = today()): string {
  const base =
    bill.status === "overdue"
      ? Number(bill.amount_paid ?? 0) > 0
        ? "partial"
        : "received"
      : bill.status;
  return isBillOverdue({ ...bill, status: base }, asOf) ? "overdue" : base;
}
