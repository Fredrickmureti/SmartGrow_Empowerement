/**
 * customerStatementDataset.ts — the ONE pure builder that turns posted AR
 * subledger rows (`customer_ledger_entries`) into a customer statement.
 *
 * WHY THIS EXISTS
 * ---------------
 * The statement subsystem used to contain two engines: the on-screen
 * statement read the canonical ledger, while the PDF/print/email snapshot
 * re-derived the statement from raw `invoices` + `payments` + `credit_notes`.
 * The second engine drifted — it filtered credit notes on a
 * `credit_note_status` value that does not exist, never filtered invoice
 * status (so draft/void invoices were charged to the customer), ignored
 * branch scope, ignored currency, and could not see refunds, deposits or
 * payment reversals.
 *
 * Screen, PDF, CSV and XLSX now project this one dataset, so they cannot
 * disagree. The ledger view is the only source of financial truth:
 *
 *   opening balance  = Σ(debit − credit) for entry_date < period_start
 *   transactions     = entries in [period_start, period_end]
 *   closing balance  = opening + Σ(debit − credit) in period
 *
 * This file is deliberately dependency-free and is mirrored verbatim at
 * `supabase/functions/_shared/reports/customerStatementDataset.ts` so the
 * edge renderer and the app cannot drift. A vitest guard
 * (`src/test/architecture/customer-statement-dataset-parity.test.ts`)
 * asserts the two copies are identical.
 */

/** A row of the `customer_ledger_entries` view. */
export interface CustomerLedgerRow {
  entry_date: string;
  doc_type: string;
  doc_id: string | null;
  doc_ref: string | null;
  debit: number | string | null;
  credit: number | string | null;
  currency?: string | null;
  created_at?: string | null;
}

/** The narrower union the statement UI and the PDF renderer understand. */
export type StatementTxnType = "invoice" | "payment" | "credit_note";

export interface StatementDatasetTxn {
  date: string;
  /** Raw ledger classification — kept for drill-down and labelling. */
  docType: string;
  /** Presentation bucket used by the UI / renderer. */
  type: StatementTxnType;
  reference: string;
  description: string;
  sourceId: string | undefined;
  debit: number;
  credit: number;
  balance: number;
}

export interface StatementDataset {
  openingBalance: number;
  transactions: StatementDatasetTxn[];
  closingBalance: number;
  totalCharges: number;
  totalCredits: number;
  /**
   * Currencies present in the ledger for this customer that are NOT the
   * statement currency. Non-empty means the statement must disclose that
   * activity separately — amounts are never summed across currencies.
   */
  otherCurrencies: string[];
}

export interface BuildStatementDatasetInput {
  rows: CustomerLedgerRow[];
  /** Inclusive lower bound. Entries strictly before this form the opening. */
  periodStart: string;
  /** Inclusive upper bound. */
  periodEnd: string;
  /**
   * When set, only entries in this currency contribute to the balances;
   * any other currency is reported through `otherCurrencies`.
   */
  currency?: string | null;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n as number) ? (n as number) : 0;
}

/** Date-only comparison — the ledger's `entry_date` is a calendar date. */
function day(value: string): string {
  return String(value).slice(0, 10);
}

export function mapLedgerTxnType(docType: string): StatementTxnType {
  if (docType === "invoice") return "invoice";
  if (docType === "credit_note") return "credit_note";
  // payment | deposit | refund | payment_reversal | journal
  return "payment";
}

export function describeLedgerDoc(docType: string, ref: string): string {
  const suffix = ref ? ` ${ref}` : "";
  switch (docType) {
    case "invoice":
      return `Invoice${suffix}`;
    case "credit_note":
      return `Credit note${suffix}`;
    case "deposit":
      return `Customer deposit${suffix}`;
    case "refund":
      return `Refund${suffix}`;
    case "payment_reversal":
      return `Payment reversal${suffix}`;
    case "payment":
      return `Payment${suffix}`;
    default:
      return `${docType}${suffix}`.trim();
  }
}

/**
 * Deterministic: the same ledger rows and period always produce the same
 * statement. Ordering is entry_date, then created_at, then doc_ref — so a
 * reprint reproduces the original document byte for byte.
 */
export function buildStatementDataset(
  input: BuildStatementDatasetInput,
): StatementDataset {
  const { periodStart, periodEnd } = input;
  if (!periodStart || !periodEnd) {
    throw new Error("buildStatementDataset: periodStart / periodEnd required");
  }
  const start = day(periodStart);
  const end = day(periodEnd);
  const currency = input.currency ? String(input.currency).toUpperCase() : null;

  const otherCurrencies = new Set<string>();
  const rows = (input.rows ?? []).filter((r) => {
    const c = r.currency ? String(r.currency).toUpperCase() : null;
    if (!currency || !c || c === currency) return true;
    otherCurrencies.add(c);
    return false;
  });

  const sorted = [...rows].sort((a, b) => {
    const da = day(a.entry_date);
    const db = day(b.entry_date);
    if (da !== db) return da < db ? -1 : 1;
    const ca = a.created_at ?? "";
    const cb = b.created_at ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    const ra = a.doc_ref ?? "";
    const rb = b.doc_ref ?? "";
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  let openingBalance = 0;
  for (const r of sorted) {
    if (day(r.entry_date) < start) openingBalance += num(r.debit) - num(r.credit);
  }

  let running = openingBalance;
  let totalCharges = 0;
  let totalCredits = 0;
  const transactions: StatementDatasetTxn[] = [];

  for (const r of sorted) {
    const d = day(r.entry_date);
    if (d < start || d > end) continue;
    const debit = num(r.debit);
    const credit = num(r.credit);
    running += debit - credit;
    totalCharges += debit;
    totalCredits += credit;
    const ref = r.doc_ref ?? "";
    transactions.push({
      date: r.entry_date,
      docType: r.doc_type,
      type: mapLedgerTxnType(r.doc_type),
      reference: ref,
      description: describeLedgerDoc(r.doc_type, ref),
      sourceId: r.doc_id ?? undefined,
      debit,
      credit,
      balance: running,
    });
  }

  return {
    openingBalance,
    transactions,
    closingBalance: running,
    totalCharges,
    totalCredits,
    otherCurrencies: Array.from(otherCurrencies).sort(),
  };
}
