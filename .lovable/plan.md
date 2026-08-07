# Commercial Compensation — Authoritative Project Status

Roadmap source: `.lovable/plan/commercial-compensation-verification-verdict-and-completion-2026-08-07.md` (Phases A–E).
This file is the live status board. Keep it updated after every implementation.

## Currently active phase
**Phase E — Ratchet and prove.** Phases A–D are complete.

## Fully implemented and verified

### Phase A — Correct the shipped writers (DONE)
- `refund_customer_atomic` resolves currency from the source credit note.
- Legacy `get_next_vendor_credit_note_number(uuid)` overload dropped.
- `apply_credit_to_invoice_atomic` no longer accepts client-supplied account ids.

### Phase B — Separate the customer-credit liability account (DONE)
- `customer_credit` role, `2215 Customer Credits` per business, bound as a default setting.
- `customer_credit_tieout` view; `snapshot_control_account_drift()` extended.

### Phase C — Reporting loop (DONE)
- Aging returns unapplied customer credits as negative residual rows.
- `useCustomerStatements.ts` now reads unapplied credit from
  `customer_credit_balances`, not `credit_notes.total - amount_applied`.
- Fiscal: the credit note transmits on its own date; the refund posts no tax lines.
- `approve_sales_return_atomic` and `issue_credit_note_for_payment_atomic`
  repaired: business-scoped numbering, no fallback numbers, sales-return
  inventory/COGS reversal, real `customer_credit_movements` rows.
- Inventory boundary proven by
  `supabase/tests/compensation_inventory_boundary_test.sql` — no compensation
  writer touches `stock_movements`.

### Phase D — AP parity (ADR 0132) (DONE)
- `vendor_credit` system account role registered and `1215 Vendor Credits`
  provisioned per business through `upsert_system_account()` (direct inserts
  into `accounts` are blocked by `enforce_system_account_helper`).
- `vendor_credit_movements` (append-only) → `vendor_credit_balances` projection,
  plus `vendor_credit_tieout` and drift snapshot coverage.
- Writers: `create_vendor_credit_note_atomic`,
  `issue_vendor_credit_note_atomic`, `apply_vendor_credit_to_bill_atomic`,
  `apply_vendor_credit_fifo_atomic`, `refund_from_vendor_atomic`.
- Legacy `confirm_vendor_credit_note_atomic` and
  `apply_vendor_credit_note_atomic` dropped — no fallback path.
- Client repointed: `useVendorCreditNotes.ts`, `src/lib/purchases/applyVendorCredit.ts`,
  `usePurchaseReturns.ts` (client-side `postPurchaseReturnGL` deleted).
- ADR written: `docs/adr/0132-vendor-compensation-parity.md`.
- Verified live: 0 rows of drift in both `customer_credit_tieout` and
  `vendor_credit_tieout`; legacy vendor writers absent from `pg_proc`.

## Pending work

### Phase E — remaining
- Extend `compensation-writer-monopoly.test.ts` further if new invariants appear
  (currently 13 tests, including the four ADR 0132 guards).
- Consider a vendor-side statement/ledger credit line audit equivalent to the
  customer statement fix (`useVendorStatements.ts` currently reads
  `vendor_ledger_entries`, which already carries `vendor_credit_note` rows).

## Instructions for the next agent

1. All database changes go through the migration tool; posting stays exclusively
   inside `post_journal_entry_atomic` (ADR 0123).
2. No client code builds journal lines, allocates document numbers, or resolves
   GL accounts.
3. System accounts are created only via `upsert_system_account()`.
