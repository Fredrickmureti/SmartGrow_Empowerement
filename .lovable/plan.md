# Commercial Compensation — Verification Result and Remaining Phases

Roadmap source: `.lovable/plan/commercial-compensation-verification-verdict-and-completion-2026-08-07.md` (Phases A–E).

## Phase 1 — Independent verification (done, against the live database)

Confirmed genuinely implemented, not merely claimed:

- **Numbering.** Only one credit-note sequence exists: `get_next_credit_note_number(_org, _business, _branch)`. `approve_sales_return_atomic` and `issue_credit_note_for_payment_atomic` both call it with full business scope and contain no timestamp fallback number. Only one vendor overload remains (`p_organization_id, p_business_id`); the legacy org-only form is gone.
- **Writer monopoly.** `create_credit_note_atomic`, `issue_credit_note_atomic`, `apply_credit_to_invoice_atomic`, `refund_customer_atomic` are the only compensation writers; `process_refund_atomic` no longer exists; `confirm_credit_note_atomic` is a 63-character shim.
- **Dead parameters removed.** `apply_credit_to_invoice_atomic` no longer takes client-supplied account ids.
- **Dedicated credit account.** Issue, apply, refund and payment conversion all resolve `customer_credit_account(business)`; each writes `customer_credit_movements`.
- **Tie-out and drift.** `customer_credit_tieout` compares the GL account to `customer_credit_balances` per business and currency; `snapshot_control_account_drift()` inserts customer-credit drift alongside AR/AP.
- **Sales return → GL.** `approve_sales_return_atomic` posts the inventory/COGS reversal and is business-scoped.
- **Statement and ledger credit lines.** Contrary to the previous status note, `customer_ledger_entries` already unions credit notes and refunds, and both `useCustomerLedger.ts` and the statement transaction list render them as credit lines. This item is already satisfied.
- Ratchet file `compensation-writer-monopoly.test.ts` contains 9 guards matching the shipped behaviour.

Newly found defect (not in the previous plan):

- **Statement aging still derives customer credit from document columns.** `useCustomerStatements.ts` computes unapplied credit as `credit_notes.total - amount_applied - refund_amount`. ADR 0131 makes `customer_credit_balances` the authority, and `useAgingReport.ts` was already migrated. The statement therefore can disagree with the aging report and the tie-out view whenever a movement exists without matching document columns.

Confirmed not started: Phase D (AP parity). There is no `vendor_credit_balances` / `vendor_credit_movements`; `apply_vendor_credit_note_atomic` still contains fallback numbering and `confirm_vendor_credit_note_atomic` remains a parallel writer.

## Phase 2 — Work to execute, in order

### C1. Make the statement read the credit ledger (new item)
Replace the `credit_notes` residual arithmetic in `useCustomerStatements.ts` with a read of `customer_credit_balances` for the contact's business/currency, keeping advance customer cash (`payments.outstanding_amount`) as-is. Aging math and buckets unchanged; only the source of "unapplied credit" changes, so statement, aging report and tie-out agree by construction.

### C2. Prove the inventory boundary
Add a database contract test asserting no compensation writer touches `stock_movements` unless a `sales_returns` document is linked through `credit_notes.source_return_id` — the ADR 0131 §5 invariant that is currently unproven.

### D. AP parity — vendor credit notes (ADR 0132)
Mirror the AR architecture:
- `vendor_credit_movements` (append-only: issue / apply / refund / expire) with `vendor_credit_balances` as its projected view, RLS on, business scoped, non-negative.
- One writer family: `create_vendor_credit_note_atomic`, `issue_vendor_credit_note_atomic`, `apply_vendor_credit_to_bill_atomic`, `refund_from_vendor_atomic` — journal lines built in the database, posted only through `post_journal_entry_atomic`.
- A `vendor_credit` GL account role provisioned per business, plus `vendor_credit_tieout` and vendor drift in `snapshot_control_account_drift()`.
- Retire `confirm_vendor_credit_note_atomic` and `apply_vendor_credit_note_atomic` (no fallbacks), remove the fallback numbering, and repoint `useVendorCreditNotes.ts` / `src/lib/purchases/applyVendorCredit.ts`.
- Extend `vendor_ledger_entries` and the vendor statement to the same credit treatment as the customer side.
- Write ADR 0132.

### E. Ratchet and prove
- Extend `compensation-writer-monopoly.test.ts` with vendor parity guards (single vendor writer family, no fallback numbering, vendor credit read from the balance) and the statement-reads-ledger guard from C1.
- Run the architecture suite and the typecheck; record the result.
- Update `mem/features/commercial-compensation.md` and ADR 0131 consequences.

## Technical notes
- All database changes go through the migration tool; new public tables get GRANTs, RLS and policies in the same migration.
- Posting stays exclusively inside `post_journal_entry_atomic` (ADR 0123). No client code builds journal lines or resolves GL accounts; hook changes are limited to argument shape and read source.
- The vendor role and ledger are introduced additively with a deposits-style fallback only for pre-existing rows, so open balances keep reconciling during rollout.
