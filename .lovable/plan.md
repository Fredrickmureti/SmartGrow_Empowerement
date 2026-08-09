# Payment & Reconciliation Convergence — Status

Authoritative status file. Update after every tranche.

**Active phase:** D4 complete (supplier advances). **Next up:** D6 — UI
consolidation + docs alignment, then D7 ratchets.

## Shipped and verified

### Tranche 1 — Money-in idempotency (D1, D2) ✅
- `payments.client_request_id` / `bill_payments.client_request_id` with partial
  unique indexes.
- `record_multi_invoice_payment` / `record_payment_atomic` accept `_request_id`,
  return the existing payment on replay, and survive concurrent insert races.
  (`record_multi_bill_payment` already had `_request_id`.)
- `supabase/functions/mpesa-c2b/index.ts`: settlement is attempted even on a
  duplicate webhook delivery, keyed on the M-Pesa `TransID`. Fixed a settlement
  failure caused by selecting a non-existent `invoices.total_amount` (now `total`).
- Clients thread request ids: `src/hooks/usePayments.ts`,
  `src/hooks/pos/usePOSInvoiceRequest.ts` (POS transaction id + tender index).
- Verified: `payment-allocations-first-class` 9/9.

### Tranche 2 — Unreconcile accounting + bank recon hardening (D3, D5) ✅
- **D3 `unreconcile_payment_atomic`** no longer makes cash vanish. It voids the
  original settlement JE (the AR credit carries invoice linkage and cannot
  survive detachment), then posts Dr Bank / Cr Customer Deposits through
  `post_journal_entry_atomic` with `source_type = 'payment_unreconcile'`
  (idempotent per payment). Adds a fiscal-period guard, repoints
  `payments.journal_entry_id` at the reclass entry, and refuses when no Customer
  Deposits account is configured. Allocations stay append-only via compensating
  negatives (ADR 0027 invariant 5).
- **D5 `reconcile_bank_transaction_atomic`** gains `_client_request_id`
  (default `brecon:<txn_id>`), threads it into both settlement engines, and
  refuses a transaction dated inside a closed fiscal period. The old 7-arg
  signature was dropped to avoid overload ambiguity.
  `src/hooks/useBankTransactions.ts` passes the deterministic key.
- Verified: `reconciliation-business-level-gating` 11/11.

### Tranche 3 — Supplier payments on account (D4) ✅
- `bill_payments.vendor_id` added (FK to `contacts`), backfilled from existing
  allocations, indexed `(business_id, vendor_id, payment_date DESC)`. An
  unapplied advance is now a first-class AP document, not an orphan row.
- `check_bill_payment_allocation_consistency` extended: allocating a payment to
  a bill stamps the header vendor when unset and rejects allocation to a bill of
  a different supplier — the AP mirror of the AR single-customer rule.
- `vendor_advance_account(business_id)` resolves `vendor_advances`, falling back
  to the existing `vendor_credit` default (asset — "Vendor Credits").
- `record_vendor_advance_payment(...)`: Dr Vendor Credits / Cr Bank through
  `post_journal_entry_atomic`, period-guarded, vendor/branch/account validated,
  idempotent by `_request_id` (returns the original payment on replay).
- Client entrypoint `recordVendorAdvance` in `src/hooks/useBills.ts`, exported
  alongside `recordMultiBillPayment`. Applying an advance to a bill later uses
  the same canonical `record_multi_bill_payment` path — no second AP writer.
- Verified: `tsgo --noEmit` clean; `bill-payment-allocations-first-class` 5/5,
  `procurement` 7/7.

## Pending

### D6 — UI consolidation + docs alignment (next)
- Collapse the duplicate payment-recording dialogs onto one component.
- Refresh ADRs 0027/0028 — they still describe `payments.invoice_id` and
  `bill_payments.bill_id` as pending drops; both columns are already gone.
- New ADR for the unreconcile reclassification rule (D3) so the cash-preserving
  behaviour cannot be silently regressed.
- New ADR (or extend 0028) for supplier advances: `bill_payments.vendor_id`,
  Vendor Credits as the holding account, allocation-later contract.
- Surface unapplied vendor cash in the AP UI (vendor ledger / vendor payments)
  so `recordVendorAdvance` is reachable by an operator, not just by code.

### D7 — Ratchets
- Architecture test asserting every money-in RPC accepts and honours a request
  key, and that no client path calls a settlement RPC without one.
- Ratchet banning a second AP writer: nothing but
  `record_multi_bill_payment` / `record_vendor_advance_payment` may insert into
  `bill_payments`.

## Instructions for the next agent
1. **Verify before extending.** Re-read the live definitions of
   `unreconcile_payment_atomic`, `reconcile_bank_transaction_atomic` and
   `record_vendor_advance_payment` from `pg_proc` rather than trusting this
   file. Confirm: the unreconcile reclass entry balances and is idempotent per
   payment; the recon RPC has exactly one signature; the vendor-advance replay
   path returns the original `bill_payment_id`.
2. Confirm `bill_payments.vendor_id` backfill left no live payment with
   allocations but a NULL vendor.
3. Then resume at **D6** — starting with the operator-facing surface for vendor
   advances, since the RPC exists but has no UI yet. Do not start unrelated
   work; finish D6 before D7.
