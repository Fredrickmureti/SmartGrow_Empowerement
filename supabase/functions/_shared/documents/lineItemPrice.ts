/**
 * resolveDisplayUnitPrice — the one rule for the "Price" column on a
 * line-item document.
 *
 * The Qty cell is rendered in DISPLAY units ("1 50 kg Bag"), so the Price
 * cell must be the price of ONE display unit, otherwise the arithmetic a
 * reader does in their head (Qty × Price = Amount) does not hold.
 *
 * `*_items.unit_price` is ambiguous across writers: some paths store it per
 * base unit (7.00 per tablet) and others per display unit (7,500.00 per
 * 50 kg bag). Blindly multiplying by the pack factor produced the
 * "1 Bag × 375,000.00 = 7,500.00" nonsense on invoices.
 *
 * So we reconcile against the line total, which is authoritative:
 *   - unit_price × displayQty ≈ line_total → already a display-unit price.
 *   - unit_price × baseQty    ≈ line_total → base-unit price, scale it up.
 *   - neither (discounts, rounding) → derive from line_total / displayQty.
 */
export function resolveDisplayUnitPrice(item: {
  quantity?: number | null;
  display_quantity?: number | null;
  packaging_label?: string | null;
  unit_price?: number | null;
  line_total?: number | null;
}): number {
  const unit = Number(item.unit_price ?? 0);
  const base = Number(item.quantity ?? 0);
  const hasPack = !!(item.packaging_label && String(item.packaging_label).trim());
  const dq =
    item.display_quantity != null && Number.isFinite(Number(item.display_quantity))
      ? Number(item.display_quantity)
      : base;

  if (!hasPack || !(dq > 0) || !(base > 0) || dq === base) return unit;

  const total = Number(item.line_total ?? NaN);
  if (Number.isFinite(total) && total !== 0) {
    if (close(unit * dq, total)) return unit;
    if (close(unit * base, total)) return unit * (base / dq);
    return total / dq;
  }

  // No total to reconcile against: assume the legacy base-unit price.
  return unit * (base / dq);
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.001);
}
