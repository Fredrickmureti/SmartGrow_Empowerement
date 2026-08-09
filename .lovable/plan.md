# Payment & Reconciliation Convergence — Status

Authoritative status file. Update after every tranche.

## Shipped

### Tranche 1 — Money-in idempotency (D1, D2)
- `payments.client_request_id` and `bill_payments.client_request_id` with partial
  unique indexes.
- `record_multi_invoice_payment` / `record_payment_atomic` accept `_request_id`,
  return the existing payment on replay, and survive concurrent insert races.
  (`record_multi_bill_payment` already had `_request_id`.)
- `supabase/functions/mpesa-c2b/index.ts`: settlement is attempted even on a
  duplicate webhook delivery, keyed on the M-Pesa `TransID`. Fixed a settlement
  failure caused by selecting a non-existent `invoices.total_amount` (now `total`).
- Clients thread request ids: `src/hooks/usePayments.ts`,
  `src/hooks/pos/usePOSInvoiceRequest.ts` (key = POS transaction id + tender index).

### Tranche 2 — Unreconcile accounting + bank recon hardening (D3, D5)
- **D3 `unreconcile_payment_atomic`**: no longer makes cash vanish. It voids the
  original settlement JE (the AR credit carries invoice linkage and cannot
  survive detachment), then posts a reclassification entry
  Dr Bank / Cr Customer Deposits through `post_journal_entry_atomic`
  (`source_type = 'payment_unreconcile'`, so it is idempotent per payment).
  Adds a fiscal-period guard, repoints `payments.journal_entry_id` at the
  reclass entry, and refuses when no Customer Deposits account is configured.
  Allocations stay append-only (compensating negatives, ADR 0027 invariant 5).
- **D5 `reconcile_bank_transaction_atomic`**: gains `_client_request_id`
  (defaulting to `brecon:<txn_id>`), threads it into both settlement engines,
  and refuses a transaction whose date sits in a closed fiscal period. The old
  7-arg signature was dropped to avoid overload ambiguity.
  `src/hooks/useBankTransactions.ts` passes the deterministic key.
- Verified: `payment-allocations-first-class` 9/9,
  `reconciliation-business-level-gating` 11/11.

## Remaining

### D4 — Vendor payments on account
- Add `bill_payments.vendor_id` (nullable, FK) so an AP payment can exist with no
  bill allocation.
- New `record_vendor_advance_payment` RPC mirroring `record_advance_payment`
  (Dr Vendor Advances / Cr Bank), idempotent by `_request_id`.
- Reader/UI surface for unapplied vendor cash, and allocation of an advance onto
  a later bill through `record_multi_bill_payment`.

### D6 — UI consolidation + docs alignment
- Collapse duplicate payment-recording dialogs onto one component.
- Refresh ADRs 0027/0028 (they still describe the legacy FK columns as pending;
  `payments.invoice_id` and `bill_payments.bill_id` are already dropped).
- Write an ADR for the unreconcile reclassification rule (D3) so the
  cash-preserving behaviour is not regressed.

### D7 — Ratchets
- Architecture test asserting every money-in RPC accepts and honours a request
  key, and that no client path calls a settlement RPC without one.

## Note for the next agent
Verify before extending: re-read the live definitions of
`unreconcile_payment_atomic` and `reconcile_bank_transaction_atomic` in
`pg_proc` rather than trusting this file, then continue at D4.
