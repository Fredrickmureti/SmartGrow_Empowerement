# Unreconcile Payment — Balance Preview Display Bug

**Date:** 2026-05-17
**Severity:** High (perceived financial integrity); Low (actual data integrity)
**Scope:** `src/components/payments/UnreconcilePaymentDialog.tsx` and its two callers.

## Observed

For a 300,000 invoice fully paid by a single 300,000 receipt, the un-reconcile
confirmation dialog displayed:

> Invoice Balance After: **KES 600,000.00**

Expected: **KES 300,000.00**.

## Backend — verified correct, untouched

`useTransactionReversal.unreconcilePayment` (src/hooks/useTransactionReversal.ts:437–517)
does the right thing:

1. Reverses the original payment JE via `reverseJEAtomic` (unwinds DR AR / CR Cash
   with correct contact attribution — audit fix B2).
2. Detaches the payment: `invoice_id = NULL`, `journal_entry_id = NULL`,
   `status = 'unreconciled'`, stamps `unreconciled_at/by/reason`.
3. Restores the invoice: `amount_paid = max(0, amount_paid − payment.amount)`,
   recomputes status (`sent` / `partial` / `paid`).

Invoice `total` is never mutated. Receivables are not doubled. The 600k was
never going to be persisted.

## Root cause — pure display

The dialog rendered:

```
total − amount_paid + payment.amount
```

That formula is only correct when `amount_paid` already includes the payment
being detached. Both callers fed it stale or hardcoded values:

- **src/pages/CustomerPayments.tsx** — the list query only selected
  `invoice:invoices(invoice_number)`, so `total` was undefined → 0 and
  `amount_paid` was **hardcoded to 0**. Garbage in, garbage out.
- **src/components/invoices/PaymentHistoryDialog.tsx** — relayed the parent
  `invoice.amount_paid`, which can be stale relative to the latest payment row
  (parent's TanStack cache vs. just-applied payment), producing
  `300 − 0 + 300 = 600`.

## Fix

`UnreconcilePaymentDialog` now owns the source of truth:

1. Props slimmed to `{ id, receipt_number, amount, invoice_id }`. The dialog
   itself fetches `id, invoice_number, total, amount_paid, status` from the
   `invoices` table on open.
2. Preview math mirrors the backend clamp exactly:
   ```
   newAmountPaid = Math.max(0, amount_paid − payment.amount)
   balanceAfter  = Math.max(0, total − newAmountPaid)
   ```
3. UI shows Invoice Total / Currently Paid / Current Balance /
   **Balance After Unreconcile**, plus a "Live invoice state at HH:MM"
   timestamp and a Skeleton while the fetch resolves. The Un-reconcile button
   is disabled until the live row is loaded.
4. Drift guard: if `amount_paid < payment.amount` (data inconsistency),
   renders an amber alert explaining that the clamp will land at zero rather
   than silently flipping numbers.
5. Both callers now pass the minimal payload; the hardcoded `amount_paid: 0`
   in CustomerPayments is gone.

## Regression lock

`src/test/architecture/unreconcile-balance-contract.test.ts` asserts:

- Dialog selects `total`, `amount_paid`, `status` from `invoices`.
- Dialog contains a `Math.max(0, amount_paid − payment.amount)` clamp.
- Dialog does NOT contain the legacy `total − amount_paid + amount` formula
  (block/line comments stripped before the check).
- Neither caller passes literal `amount_paid: 0`.
- Both callers pass `invoice_id` and do NOT synthesise an `invoice:` snapshot.

## Family

Same defect class as `docs/audit/2026-05-17-payment-receipt-totals.md` — the UI
inventing a number the backend would never produce. Both are now contract-tested.

## Out of scope

No backend, schema, RLS, JE, or reconciliation-engine changes were made. The
backend behaviour was verified end-to-end and is correct.
