/**
 * vendorStatementDataset.ts — the ONE pure builder that turns posted AP
 * subledger rows (`vendor_ledger_entries`) into a vendor statement.
 *
 * WHY THIS EXISTS
 * ---------------
 * AP carried the same defect AR had before ADR 0132: the on-screen vendor
 * statement read the canonical ledger, while the PDF / CSV / email snapshot
 * re-derived the account from raw `bills` + `bill_payments` +
 * `vendor_credit_notes`. That second engine hard-coded a bill/credit-note
 * status vocabulary, resolved payments through the per-bill FK (so a single
 * payment settling several bills was mis-attributed), ignored branch scope
 * and currency, and aged from `total - amount_paid` against the browser
 * clock instead of the GL-anchored open items as of the period end.
 *
 * Screen, PDF, CSV and email now project this one dataset.
 *
 * SIGN CONVENTION
 * ---------------
 * `vendor_ledger_entries` follows the GL: credit increases what we owe the
 * vendor (a bill), debit decreases it (cash out, vendor credit). A statement
 * reads the other way round — charges first. So the rows are sign-swapped
 * once, here, and then folded through the exact same accumulator the
 * customer statement uses:
 *
 *   opening balance  = Σ(charges − credits) for entry_date < period_start
 *   transactions     = entries in [period_start, period_end]
 *   closing balance  = opening + Σ(charges − credits) in period
 *
 * This file is dependency-free and mirrored verbatim at
 * `supabase/functions/_shared/reports/vendorStatementDataset.ts`; a vitest
 * guard asserts the two copies are identical.
 */
import {
  buildStatementDataset,
  type StatementDataset,
  type StatementDatasetTxn,
} from "./customerStatementDataset.ts";

/** A row of the `vendor_ledger_entries` view. */
export interface VendorLedgerRow {
  entry_date: string;
  doc_type: string;
  doc_id: string | null;
  doc_ref: string | null;
  debit: number | string | null;
  credit: number | string | null;
  currency?: string | null;
  created_at?: string | null;
}

export type VendorStatementTxnType = "bill" | "payment" | "vendor_credit_note";

export interface VendorStatementDatasetTxn
  extends Omit<StatementDatasetTxn, "type"> {
  type: VendorStatementTxnType;
}

export interface VendorStatementDataset
  extends Omit<StatementDataset, "transactions"> {
  transactions: VendorStatementDatasetTxn[];
}

export interface BuildVendorStatementDatasetInput {
  rows: VendorLedgerRow[];
  periodStart: string;
  periodEnd: string;
  currency?: string | null;
}

export function mapVendorLedgerTxnType(docType: string): VendorStatementTxnType {
  if (docType === "bill") return "bill";
  if (docType === "vendor_credit_note" || docType === "credit_note") {
    return "vendor_credit_note";
  }
  // bill_payment | payment | advance | payment_reversal | journal
  return "payment";
}

export function describeVendorLedgerDoc(docType: string, ref: string): string {
  const suffix = ref ? ` ${ref}` : "";
  switch (docType) {
    case "bill":
      return `Bill${suffix}`;
    case "vendor_credit_note":
    case "credit_note":
      return `Vendor credit${suffix}`;
    case "bill_payment":
    case "payment":
      return `Payment${suffix}`;
    case "advance":
      return `Supplier advance${suffix}`;
    case "payment_reversal":
      return `Payment reversal${suffix}`;
    default:
      return `${docType}${suffix}`.trim();
  }
}

/**
 * Deterministic: the same ledger rows and period always produce the same
 * statement, so a reprint reproduces the original document.
 */
export function buildVendorStatementDataset(
  input: BuildVendorStatementDatasetInput,
): VendorStatementDataset {
  // Swap GL signs into statement signs (charge = we owe more).
  const swapped = (input.rows ?? []).map((r) => ({
    entry_date: r.entry_date,
    doc_type: r.doc_type,
    doc_id: r.doc_id,
    doc_ref: r.doc_ref,
    debit: r.credit,
    credit: r.debit,
    currency: r.currency,
    created_at: r.created_at,
  }));

  const base = buildStatementDataset({
    rows: swapped,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    currency: input.currency,
  });

  return {
    ...base,
    transactions: base.transactions.map((t) => ({
      ...t,
      type: mapVendorLedgerTxnType(t.docType),
      description: describeVendorLedgerDoc(t.docType, t.reference),
    })),
  };
}
