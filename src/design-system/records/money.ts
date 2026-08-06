/**
 * money — the one derivation of a document's financial summary.
 *
 * Every record page previously assembled its own totals array inline, which
 * is why "Balance due" appeared on some documents, "Outstanding" on others,
 * and paid/balance was omitted entirely on a few. Callers now hand over the
 * raw amounts and a formatter; the shape of the summary is decided here.
 */
import type { DocumentTotalsRow } from "./panels";

export interface DocumentMoney {
  subtotal?: number | null;
  discount?: number | null;
  tax?: number | null;
  shipping?: number | null;
  total?: number | null;
  paid?: number | null;
  /** Omit to derive as total - paid (floored at zero). */
  balance?: number | null;
  currency?: string | null;
}

export interface DerivedMoney extends DocumentMoney {
  total: number;
  paid: number;
  balance: number;
}

export function deriveMoney(money: DocumentMoney): DerivedMoney {
  const total = money.total ?? 0;
  const paid = money.paid ?? 0;
  const balance = money.balance ?? Math.max(0, total - paid);
  return { ...money, total, paid, balance };
}

interface BuildTotalsOptions {
  format: (value: number) => string;
  /** Show the paid / balance pair. Defaults to true when `paid` is present. */
  showSettlement?: boolean;
  /** Label for the settlement remainder ("Balance due", "Refund due", …). */
  balanceLabel?: string;
}

/**
 * Build the canonical totals ladder:
 *   Subtotal → Discount → Tax → Shipping → Total → Paid → Balance
 * Rows with no value are dropped so a document never shows an empty "Tax —".
 */
export function buildTotalsRows(
  money: DocumentMoney,
  { format, showSettlement, balanceLabel = "Balance due" }: BuildTotalsOptions,
): DocumentTotalsRow[] {
  const d = deriveMoney(money);
  const rows: DocumentTotalsRow[] = [];

  if (d.subtotal != null) rows.push({ label: "Subtotal", value: format(d.subtotal) });
  if (d.discount) rows.push({ label: "Discount", value: `− ${format(d.discount)}`, muted: true });
  if (d.tax != null && d.tax !== 0) rows.push({ label: "Tax", value: format(d.tax) });
  if (d.shipping) rows.push({ label: "Shipping", value: format(d.shipping) });

  rows.push({ label: "Total", value: format(d.total), emphasized: true });

  const settle = showSettlement ?? money.paid != null;
  if (settle) {
    rows.push({ label: "Paid", value: format(d.paid), muted: true });
    rows.push({ label: balanceLabel, value: format(d.balance), emphasized: true });
  }

  return rows;
}
