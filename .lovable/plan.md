# Commercial Compensation — Authoritative Project Status

Roadmap source: `.lovable/plan/commercial-compensation-verification-verdict-and-completion-2026-08-07.md` (Phases A–E).
This file is the live status board. Keep it updated after every implementation.

## Currently active phase
**Phase C — Close the reporting loop.** Substantially complete; remaining item listed below.

## Fully implemented and verified

### Phase A — Correct the shipped writers (DONE)
- `refund_customer_atomic` resolves currency from the source credit note, not `businesses.base_currency`.
- Legacy `get_next_vendor_credit_note_number(uuid)` overload dropped (PostgREST ambiguity removed).
- `apply_credit_to_invoice_atomic` no longer accepts `_customer_deposits_account_id` / `_receivable_account_id`; accounts are resolved server-side. `useCreditNotes.ts` updated.

### Phase B — Separate the customer-credit liability account (DONE)
- `customer_credit` system account role registered; `2215 Customer Credits` provisioned per business and bound as a default setting.
- `customer_credit_account(business)` resolver with a `customer_deposits` fallback for legacy data.
- `issue_credit_note_atomic`, `apply_credit_to_invoice_atomic`, `refund_customer_atomic` all post to the dedicated account.
- `customer_credit_tieout` view (security_invoker) compares the subledger to the GL account per business/currency.
- `snapshot_control_account_drift()` extended with customer-credit drift, mirroring AR/AP.
- `useDefaultAccounts.ts` exposes `customer_credit_id`.

### Phase C — Reporting loop (DONE except one item)
- Aging: `get_ar_ap_aging_from_ledger` now returns unapplied customer credits as negative residual rows ("Unapplied credit"); `useAgingReport.ts` preserves negative residuals, buckets them as current, and folds them into contact totals so the net position is true.
- Fiscal: `tg_credit_note_fiscal_enqueue` verified — a credit note transmits on its own document date; the refund posts no tax lines, so there is no double reporting.
- Sales returns → credit note: `approve_sales_return_atomic` repaired.
  - It was calling the retired org-only numbering overload, so every return approval would have failed. Now business-scoped.
  - Stock restored on approval now posts the matching GL entry — DR Inventory / CR COGS — valued at `cost_at_shipment` from the originating delivery note, falling back to product cost. Guarded by `is_period_open`, `assert_no_existing_source_posting`, and skipped when inventory/COGS accounts are unconfigured.
- Payment → credit note: `issue_credit_note_for_payment_atomic` repaired.
  - Business-scoped numbering; the timestamp `CN-<epoch>` fallback number is gone (a document that cannot be numbered is not created).
  - The converted credit is now written to `customer_credit_movements`, so it is a real, spendable balance. Previously it was an issued credit note with no ledger row.
  - GL now lands on the dedicated Customer Credits account (both the applied-payment and unapplied-advance paths) instead of commingling with customer deposits.
- Ratchet: two new guards in `src/test/architecture/compensation-writer-monopoly.test.ts` (business-scoped numbering with no fallback in both writers; sales-return COGS reversal present). Full file: 9 tests passing.

## Pending work

### Phase C — remaining
- Customer statements and the partner ledger (`useCustomerStatements.ts`, `useCustomerLedger.ts`) were audited but not yet extended: an outstanding customer credit should appear as a credit line on the statement and in the ledger, matching the aging treatment already shipped.
- Confirm a credit note with no linked sales return moves no stock (expected true — no writer touches `stock_movements` — but it is unproven by test).

### Phase D — Extend compensation architecture to AP (ADR 0132) — NOT STARTED
- Mirror ADR 0131 for vendor credit notes: one create/issue/apply/refund writer family, a vendor credit ledger projected from append-only movements, business-scoped numbering, server-built journal lines, a vendor-credit GL role plus tie-out view and drift snapshot.
- Retire `confirm_vendor_credit_note_atomic` / `apply_vendor_credit_note_atomic` rather than leaving fallbacks.
- Write ADR 0132.

### Phase E — Ratchet and prove — NOT STARTED
- Extend the architecture test to cover vendor parity and the remaining invariants.
- Run the full architecture suite plus typecheck and record the result.
- Update `mem/features/commercial-compensation.md` and ADR 0131 consequences.

## Instructions for the next agent

1. **Verify before building.** Confirm against the live database, not the migration files alone:
   - `approve_sales_return_atomic` and `issue_credit_note_for_payment_atomic` both call `get_next_credit_note_number(org, business, branch)` and contain no fallback numbering.
   - Approving a sales return produces exactly one balanced `sales_return` journal entry (DR Inventory / CR COGS) and one `customer_credit_movements` row is created when converting a payment.
   - `customer_credit_tieout` returns zero drift for existing data.
   - `bunx vitest run src/test/architecture` and `tsgo` are clean.
2. **Then finish Phase C**: customer statements and partner ledger credit lines, plus the no-stock-movement proof.
3. **Then start Phase D** (AP parity, ADR 0132) — do not jump ahead to Phase E or to unrelated subsystems.
4. All database changes go through the migration tool; posting stays exclusively inside `post_journal_entry_atomic` (ADR 0123); no client code builds journal lines or resolves GL accounts.
