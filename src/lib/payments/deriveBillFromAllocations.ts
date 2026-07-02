/**
 * ADR 0028 — Derive the legacy `bill_payment.bill` display shape from
 * `bill_payment_allocations`.
 *
 * AP mirror of `deriveInvoiceFromAllocations`. Before ADR 0028, every
 * `bill_payments` row carried a single `bill_id` FK and UI code consumed
 * `payment.bill?.bill_number` directly. Allocations are now the canonical
 * link (a single vendor payment can settle 1..N bills, partial, over, or
 * none — e.g. one bank transfer covering 20 vendor invoices), so the FK
 * column is on a deprecation path. To keep read-only UI surfaces working
 * unchanged during the deprecation window, we synthesize a
 * backwards-compatible `bill` object from the allocation join.
 *
 * Display contract (matches the AR helper exactly):
 *   - 0 allocations -> null (unapplied / pure vendor prepayment)
 *   - 1 allocation  -> { id, bill_number, total }
 *   - N>1           -> { id, bill_number: "BILL-001 +N more", total }
 *
 * `allocation_count` is exposed so callers that want richer rendering
 * (e.g. tooltip with the full bill list) can branch on it.
 */
export interface BillPaymentAllocationLite {
  amount: number | string;
  bill: {
    id: string;
    bill_number: string;
    total?: number | string | null;
  } | null;
}

export interface DerivedPaymentBill {
  id?: string;
  bill_number: string;
  total?: number;
  allocation_count: number;
}

export function deriveBillFromAllocations(
  allocations: BillPaymentAllocationLite[] | null | undefined,
): DerivedPaymentBill | null {
  if (!allocations || allocations.length === 0) return null;
  const withBill = allocations.filter((a) => a.bill);
  if (withBill.length === 0) return null;
  const first = withBill[0].bill!;
  const n = withBill.length;
  return {
    id: first.id,
    bill_number:
      n === 1 ? first.bill_number : `${first.bill_number} +${n - 1} more`,
    total: first.total != null ? Number(first.total) : undefined,
    allocation_count: n,
  };
}