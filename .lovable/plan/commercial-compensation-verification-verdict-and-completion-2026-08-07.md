# Commercial Compensation — Verification Verdict and Completion Plan

## Verdict on the previous engineer's work

Mostly real, not shallow. Verified directly against the live database and code:

- `get_next_credit_note_number(_org, _business, _branch)` exists, is business-scoped and advisory-locked. The original 400 is genuinely fixed.
- `create_credit_note_atomic`, `issue_credit_note_atomic`, `apply_credit_to_invoice_atomic`, `refund_customer_atomic` all exist as SECURITY DEFINER writers; `process_refund_atomic` is dropped; `confirm_credit_note_atomic` is a 63-character shim.
- Issuing builds journal lines in the database, splits the credit between receivable (only up to the invoice's open balance) and customer credit, and posts through `post_journal_entry_atomic`.
- `customer_credit_balances` / `customer_credit_movements` exist with append-only and projection triggers, RLS on, and are read as the authority by `useCustomerCredits.ts`.
- Refunds are idempotent by `client_request_id` and are capped by available credit.
- ADR 0131 and the ratchet test `compensation-writer-monopoly.test.ts` exist and match the shipped code.

Five defects and gaps the previous engineer did not close are listed below. They are the remaining work.

## Confirmed defects

1. **Refund currency bug.** `refund_customer_atomic` writes `customer_refunds.currency` from `businesses.base_currency`, but the credit balance it drains is keyed by the credit note's own currency. A foreign-currency credit note produces a refund row in the wrong currency while draining the correct-currency balance.
2. **Duplicate vendor numbering overload.** Both `get_next_vendor_credit_note_number(uuid)` and `(uuid, uuid)` are live. PostgREST resolves overloads by argument names, so the legacy org-only form is a live drift path and an ambiguity hazard.
3. **Customer credit and customer deposits share one GL account.** Both `issue_credit_note_atomic` and `refund_customer_atomic` resolve `compensation_account(business,'customer_deposits')`. Credit-note credit and customer prepayments therefore commingle in one account, so the credit liability can never be tied out to `customer_credit_balances` the way AR/AP are tied out under ADR 0030/0032.
4. **Dead client-supplied account parameters.** `apply_credit_to_invoice_atomic` still accepts `_customer_deposits_account_id` and `_receivable_account_id`; the body ignores them and resolves accounts server-side. Leaving them in the signature invites a client to think it decides GL accounts.
5. **Vendor (AP) side is unreformed.** `confirm_vendor_credit_note_atomic` / `apply_vendor_credit_note_atomic` remain a parallel family with no vendor credit ledger — the exact architecture ADR 0131 removed on the AR side.

## Plan

### Phase A — Correct the shipped writers
- Fix `refund_customer_atomic` to take currency from the credit note (payments keep the payment's currency), and reject a refund whose currency does not match the drained balance.
- Drop the legacy `get_next_vendor_credit_note_number(uuid)` overload after repointing any caller.
- Drop the two unused account parameters from `apply_credit_to_invoice_atomic` and update `useCreditNotes.ts` accordingly.

### Phase B — Separate the customer-credit liability account
- Introduce a distinct `customer_credit` account role (seeded per business, falling back to the existing deposits account only for pre-existing data), and use it in issue, apply and refund.
- Add a `customer_credit_tieout` view comparing the GL balance of that account against `customer_credit_balances`, and extend the nightly drift snapshot so any divergence is recorded exactly as AR/AP drift is.

### Phase C — Close the reporting loop
- Verify and, where missing, wire customer credit into aging, customer statements and the partner ledger so an outstanding credit shows as a credit position rather than vanishing.
- Verify the credit note enqueues its own fiscal/eTIMS transmission on its own document date, and that the refund does not double-report tax.
- Verify the `sales_returns` link actually drives stock and COGS reversal, and that a credit note without a return moves no stock.

### Phase D — Extend the compensation architecture to AP (ADR 0132)
- Mirror ADR 0131 for vendor credit notes: one create/issue/apply/refund writer family, a vendor credit ledger projected from append-only movements, business-scoped numbering, and server-built journal lines.
- Retire the legacy vendor writers rather than leaving them as fallbacks.

### Phase E — Ratchet and prove
- Extend `compensation-writer-monopoly.test.ts` to cover the new invariants: no `customer_deposits` account role used for credit-note credit, no duplicate numbering overload, no client-supplied account ids on compensation writers, and vendor parity.
- Run the full architecture test suite and the typecheck, and record the result. Update `mem/features/commercial-compensation.md` and ADR 0131's consequences with the corrections.

## Technical notes
- All changes to database functions go through the migration tool; posting remains exclusively through `post_journal_entry_atomic` (ADR 0123).
- No client code will build journal lines or resolve GL accounts; hook changes are limited to argument shape.
- Account-role introduction is additive with a fallback so existing balances keep reconciling during rollout.
