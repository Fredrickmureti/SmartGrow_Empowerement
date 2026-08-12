# ADR 0134 — Expense and customer-refund reversal parity

Status: Accepted
Date: 2026-08-12
Related: 0125 (payment reversal single writer), 0126 (AP reversal single writer),
0127 (invoice void single writer), 0128 (goods receipt reversal), 0129 (reversal
reason codes + register), 0130 (POS/payroll reversal parity), 0132 (vendor
compensation parity), 0133 (AP credit position).

## Context

Every money-moving document in the system reverses through the same fabric:

```text
resolve_reversal_intent(type, id)        -> what is legal, and why not
preview_reversal_consequences(type, id)  -> what a reversal would touch
<single writer RPC>                      -> the only path that mutates state
reversal_reason_codes + governance       -> why, and who allowed it
```

Two documents sat outside it.

**Expenses.** Voiding an expense was a bare menu item: no reason code, no
consequence preview, no approval gate — while the identical action on a bill
demanded all three. Worse, an expense flagged `reimburse_via_payroll` stayed in
the payroll reimbursement queue after being voided, so `compute-payroll` still
paid the employee for an expense that had been reversed out of the ledger. That
is a cash leak, not a UX gap.

**Customer refunds.** A refund is cash that has already left the bank. There was
no intent resolver, no preview branch, and no surface — the only way a user
learned a refund is not voidable was to not find a button. Silence is not an
answer; the system knew the correct corrective move and never said it.

## Decision

1. **Expense void joins the reversal fabric.**
   - `expense_void(_expense_id, _reason, _reason_code, …)` is the single writer.
     Reason codes are validated against `reversal_reason_codes` server-side.
   - `resolve_reversal_intent_expense` decides legality from status, fiscal
     period, reimbursement state, any bill raised from the expense, and the
     payroll queue. `queued_for_payroll` is a hard blocker: an expense awaiting
     payroll reimbursement must be pulled from the queue before it can be voided.
   - `compute-payroll` only picks up expenses in a payable status, so a voided
     expense can never reach a payslip even if it slips past the UI.
   - `VoidExpenseDialog` is the only expense reversal surface. Menu items must
     open it; direct `voidExpense` calls from menus are forbidden.

2. **Customer refunds resolve intent, and refuse honestly.**
   - `resolve_reversal_intent_customer_refund` returns `void` as *not allowed*
     with the corrective instruction: a paid refund is corrected by recording a
     customer receipt for the money coming back, never by voiding cash out of
     the bank. Terminal state and closed periods are separate blockers.
   - `ReverseCustomerRefundSheet` (opened from the customer ledger's refund
     rows) renders that answer and routes the user to record the receipt.

3. **Preview enrichment is per document type, never a growing monolith.**
   `preview_reversal_consequences_core` stays generic (GL by
   `source_type`/`source_id`) plus its existing branches.
   `preview_reversal_consequences` dispatches to
   `preview_reversal_extras_<type>` and merges money lines, related-document
   counts and warnings:
   - `preview_reversal_extras_expense` — analytic distributions and project cost
     entries withdrawn, the employee reimbursement cancelled, any converted
     bill, and an **error** warning when the expense is still queued for payroll.
   - `preview_reversal_extras_customer_refund` — the bank cash-out leg, and the
     source receipt or credit note the refund was drawn from.

4. **Coverage is derived, not curated.**
   `src/test/architecture/reversal-intent-coverage.test.ts` derives the expected
   set of intent branches from SQL rather than a hand-maintained whitelist, so a
   new reversible document type cannot be added without a resolver.

## Consequences

- Every reversible document now answers the same three questions before anyone
  authorises anything: is it legal, what will it touch, and why are we doing it.
- The payroll cash leak is closed at two levels — blocked in the intent
  resolver and filtered in `compute-payroll`.
- Adding preview detail for a new document type means writing one
  `preview_reversal_extras_<type>` function and one dispatch line; the core
  preview and the shared renderer are not touched.
- The consequence preview renderer stays purely presentational: expense and
  refund detail is expressed in the existing money / related-document / warning
  vocabulary rather than a per-module fork.

## Non-goals

- No refund void path. If a refund was genuinely issued in error and the money
  is recovered, the recovery is a receipt — a real event with its own bank leg.
- No second approval engine: expense reversal approvals route through
  ADR-0101's governance engine like every other reversal.
