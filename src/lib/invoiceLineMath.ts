/**
 * Canonical invoice/credit-note/estimate line math.
 *
 * CONTRACT (enforced by `confirm_invoice_atomic` in the database):
 *   invoice_items.line_total  = tax-EXCLUSIVE  (= quantity × unit_price − line discount)
 *   invoice_items.tax_amount  = per-line tax on the discounted, tax-exclusive amount
 *   invoices.subtotal         = SUM(line_total)
 *   invoices.tax_amount       = SUM(tax_amount)
 *   invoices.total            = subtotal + tax − header discount
 *
 * Tax rate is stored as a percent (e.g. 16 for 16%, NOT 0.16).
 *
 * All numeric outputs are rounded to 2 decimal places to match the
 * `ROUND(..., 2)` comparisons used by the SQL totals validator and to
 * eliminate IEEE-754 drift before persistence.
 */

export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  // Avoid float artefacts like 16.0000000003 by routing through a string.
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface LineMathInput {
  quantity: number | null | undefined;
  unit_price: number | null | undefined;
  discount_percent?: number | null;
  tax_rate?: number | null;
}

export interface LineMathResult {
  /** Tax-exclusive, discount-applied amount. Persisted as `invoice_items.line_total`. */
  line_total: number;
  /** Per-line tax. Persisted as `invoice_items.tax_amount`. */
  tax_amount: number;
  /** quantity × unit_price (pre-discount, pre-tax). For UI display only. */
  gross: number;
  /** Line discount amount (before tax). For UI display only. */
  discount: number;
}

export function computeLine(input: LineMathInput): LineMathResult {
  const qty = Number(input.quantity ?? 0);
  const price = Number(input.unit_price ?? 0);
  const discountPct = Number(input.discount_percent ?? 0);
  const taxRate = Number(input.tax_rate ?? 0);

  const gross = round2(qty * price);
  const discount = round2((gross * discountPct) / 100);
  const taxable = round2(gross - discount);
  const tax = round2((taxable * taxRate) / 100);

  return {
    line_total: taxable,
    tax_amount: tax,
    gross,
    discount,
  };
}

export interface TotalsInput {
  line_total: number | null | undefined;
  tax_amount: number | null | undefined;
}

export interface TotalsResult {
  subtotal: number;
  tax_total: number;
  total: number;
}

/**
 * Aggregate header totals from already-computed lines.
 * `header_discount` is applied AFTER subtotal+tax (matches SQL validator).
 */
export function computeTotals(
  lines: ReadonlyArray<TotalsInput>,
  header_discount: number = 0,
): TotalsResult {
  let subtotal = 0;
  let tax_total = 0;
  for (const l of lines) {
    subtotal += Number(l.line_total ?? 0);
    tax_total += Number(l.tax_amount ?? 0);
  }
  subtotal = round2(subtotal);
  tax_total = round2(tax_total);
  const total = round2(subtotal + tax_total - Number(header_discount || 0));
  return { subtotal, tax_total, total };
}