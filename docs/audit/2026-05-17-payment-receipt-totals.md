# Payment Receipt Totals — Integrity Audit & Fix

**Date:** 2026-05-17
**Severity:** Critical (financial rendering)
**Module:** Invoicing / AR settlement / Receipt generation

## Symptom
Invoice 300,000 + payment 300,000 → receipt rendered `Subtotal 300,000 / Total 600,000` with a single line item.

## Reproduction
```
select p.id, p.amount,
       (select count(*) from payment_allocations where payment_id=p.id) as alloc_count
  from payments p where receipt_number='RCP-000001';
-- amount=300000, alloc_count=0, invoice_id set, invoice.amount_paid=300000, status=paid
```

## Root causes (two compounding defects)

1. **Write path** — `record_payment_atomic` never wrote `payment_allocations` rows. Every payment was a "legacy single-invoice link" (only `payments.invoice_id` set). `Σ allocations` was therefore always 0.
2. **Render path** — `fetchReceipt` in `supabase/functions/generate-document/index.ts` computed
   `total = displayAmount + unapplied`, where `unapplied = max(0, payment.amount - Σ allocations)`. With `Σ allocations = 0` and `payment.amount = 300k`, `unapplied = 300k` was added to the rendered total without emitting a matching line item — producing 600k.

The `hasLegacyInvoiceLink` guard added later would have masked the symptom but was not yet deployed; even if it had been, the underlying architecture was still wrong (totals derived independently of items).

## Fix

### Write path — migration `record_payment_atomic` v2
- Inserts a `payment_allocations` row for every applied portion (single source of truth).
- Idempotent on `(organization_id, receipt_number)` via a partial unique index; a duplicate submit returns the prior payment instead of creating a second row.
- Hard invariant before returning: `ABS((Σ allocations + overpayment) - payment.amount) ≤ 0.005`. Raises on violation.
- Backfilled all historical payments with `invoice_id` but no allocation row.

### Render path — `fetchReceipt`
- Builds `items` first.
- `subtotal = Σ items.line_total`, `tax = Σ items.tax_amount`, `total = subtotal + tax`. **No** independent addition of `payment.amount` or `unapplied`.
- Drift between `Σ items` and `payment.amount` is logged (`console.warn`) but never inflates the rendered total.

### ERP parity
Matches Odoo / NetSuite / ERPNext customer-receipt convention: a receipt is the rendering of allocation rows plus an explicit on-account line when an overpayment exists. Total ≡ Σ lines.

## Tests
- `src/test/architecture/receipt-totals-contract.test.ts` — regex-pins the items-as-truth contract and forbids the old `displayAmount + unapplied` shape (3 passing).
- Backfill verified via SQL: every recent payment now has `alloc_count = 1` and `alloc_sum = amount`.

## Deployment
`generate-document` edge function redeployed.

## Out of scope (kept untouched)
- Receipt PDF template styling.
- Multi-invoice payment paths (already used `payment_allocations`; now uniformly consumed).
- Historical invoice/JE postings (unchanged — the AR Dr/Cr semantics were already correct).
