/**
 * VendorCreditNoteTotalsPreview — the client-side *preview* of document money.
 *
 * The server recomputes subtotal / tax / total from the lines it accepts
 * (`create_vendor_credit_note_atomic` → `_resolve_vendor_credit_note_lines`),
 * so this is an operator aid, never the source of truth. It lives in one
 * component so the create and edit forms cannot drift apart.
 */
export interface VendorCreditNoteTotals {
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
}

export function computeVendorCreditNoteTotals(
  lines: { quantity: number; unit_price: number; tax_amount: number; line_total: number }[],
): VendorCreditNoteTotals {
  return lines.reduce<VendorCreditNoteTotals>(
    (acc, line) => ({
      subtotal: acc.subtotal + (Number(line.quantity) || 0) * (Number(line.unit_price) || 0),
      taxTotal: acc.taxTotal + (Number(line.tax_amount) || 0),
      grandTotal: acc.grandTotal + (Number(line.line_total) || 0),
    }),
    { subtotal: 0, taxTotal: 0, grandTotal: 0 },
  );
}

interface Props {
  totals: VendorCreditNoteTotals;
  formatCurrency: (value: number) => string;
}

export function VendorCreditNoteTotalsPreview({ totals, formatCurrency }: Props) {
  return (
    <div className="flex justify-end">
      <div className="w-64 space-y-2 text-sm">
        <div className="flex justify-between">
          <span>Subtotal:</span>
          <span className="tabular-nums">{formatCurrency(totals.subtotal)}</span>
        </div>
        <div className="flex justify-between">
          <span>Tax:</span>
          <span className="tabular-nums">{formatCurrency(totals.taxTotal)}</span>
        </div>
        <div className="flex justify-between border-t pt-2 text-lg font-bold">
          <span>Total:</span>
          <span className="tabular-nums">{formatCurrency(totals.grandTotal)}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Preview only — the server recomputes these amounts from the accepted lines.
        </p>
      </div>
    </div>
  );
}
