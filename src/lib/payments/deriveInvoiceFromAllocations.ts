/**
 * ADR 0027 — Derive the legacy `payment.invoice` display shape from
 * `payment_allocations`.
 *
 * Before ADR 0027, every payment row carried a single `invoice_id` FK and
 * UI code consumed `payment.invoice?.invoice_number` directly. Allocations
 * are now the canonical link (a payment can settle 1..N invoices, partial,
 * over, or none), so the FK column is being dropped. To keep the dozens
 * of read-only UI sites (`PaymentListTable`, exports, contact 360, etc.)
 * working unchanged, we synthesize a backwards-compatible `invoice` object
 * from the allocation join.
 *
 * Display contract:
 *   - 0 allocations -> null (unapplied / pure customer deposit)
 *   - 1 allocation  -> { id, invoice_number, total }
 *   - N>1           -> { id, invoice_number: "INV-001 +N more", total }
 *
 * `allocation_count` is exposed so callers that want richer rendering
 * (e.g. tooltip with the full list) can branch on it.
 */
export interface PaymentAllocationLite {
  amount: number | string;
  invoice: {
    id: string;
    invoice_number: string;
    total?: number | string | null;
  } | null;
}

export interface DerivedPaymentInvoice {
  id?: string;
  invoice_number: string;
  total?: number;
  allocation_count: number;
}

export function deriveInvoiceFromAllocations(
  allocations: PaymentAllocationLite[] | null | undefined,
): DerivedPaymentInvoice | null {
  if (!allocations || allocations.length === 0) return null;
  const withInvoice = allocations.filter((a) => a.invoice);
  if (withInvoice.length === 0) return null;
  const first = withInvoice[0].invoice!;
  const n = withInvoice.length;
  return {
    id: first.id,
    invoice_number:
      n === 1 ? first.invoice_number : `${first.invoice_number} +${n - 1} more`,
    total: first.total != null ? Number(first.total) : undefined,
    allocation_count: n,
  };
}
