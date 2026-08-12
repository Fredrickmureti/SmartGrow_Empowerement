# Expense reversal: close the "out of scope" gap properly

## What I verified (not assumed)

I traced the expense lifecycle end to end and then traced how a reversal of an
expense travels through the platform's business events.

**Lifecycle (server-owned, confirmed):**

```text
draft ─submit─▶ submitted ─approve─▶ approved ─void─▶ voided
                    └─reject─▶ rejected            (paid ─void─▶ voided)
```

- Commands: `expense_submit / expense_approve / expense_reject / expense_void /
  expense_convert_to_bill`, plus `expense_queue_payroll_reimbursement`,
  `expense_unqueue_payroll_reimbursement`, `expense_reimburse_direct`.
- Posting: `post_expense_gl` → `post_journal_entry_atomic` (single engine).
- Downstream of an approved expense: GL journal, `analytic_distributions`,
  `project_cost_entries` (via `trg_expenses_cost`), employee reimbursement
  payable, optional conversion to a vendor bill, automation/SMS notifications,
  `reversal_register`.

**The "out of scope" item is not a cosmetic test row.** Three confirmed defects:

1. `resolve_reversal_intent('expense', …)` **raises** —
   `resolve_reversal_intent_finance` has branches only for invoice, payment,
   bill, bill_payment, goods_receipt and ends with
   *"does not know document type %"*. Anything that asks the intent authority
   about an expense errors, including `reversal_approval_requirement`, which
   calls the intent resolver first. So expense reversals can never be gated by
   the reversal approval policy, even though `reversal.expense` is registered
   in `governance_action_registry` and `reversal_register` publishes that
   action key. The audit trail advertises a control that cannot run.
2. **A voided expense can still be paid through payroll.** `expense_void`
   blocks only when the expense is already reimbursed. A queued-but-unpaid
   employee expense (`reimburse_via_payroll = true`,
   `reimbursed_payslip_id IS NULL`) stays queued after the void, and
   `compute-payroll` selects reimbursements with no status filter — so the
   voided expense is paid to the employee as a non-taxable earning while the
   liability it was paying has already been reversed out of the ledger. This
   is real cash leaving the business against a reversed document.
3. **Expense reversal has no reason vocabulary.** Every other void writer calls
   `assert_reversal_reason`; `expense_void` takes free text, never writes
   `expenses.void_reason_code` (the column exists), and no row in
   `reversal_reason_codes` lists `expense` in `applies_to`. The register column
   is therefore always blank for expenses, and the UI voids with an
   auto-generated string and no confirmation step.

**Bonus finding from the same trace:** `customer_refund` is in the coverage
test's whitelist but is *also* missing from `resolve_reversal_intent_finance`.
The whitelist is hand-maintained and currently asserts coverage that does not
exist. That is the deeper bug: the guard trusts a constant instead of the
server.

Verdict: the out-of-scope call was wrong. It described a failing test row; the
underlying condition is an unguarded reversal path with a cash-leak edge case.

## What to build

### 1. Intent branch for expense (and customer_refund)
Add an `expense` branch to `resolve_reversal_intent_finance` returning the same
envelope shape as the others (document number, org/business, status, total,
`state`, `blockers`, `operations`, `recommended`). Operations:

- `void` — allowed when status is `approved`/`paid`, period open, not already
  voided, not reimbursed, no live bill from `expense_convert_to_bill`, and not
  queued for payroll unless the caller un-queues first.
- `convert_to_bill` surfaced as the alternative when a supplier bill owns the
  liability, matching the existing `expense_convert_to_bill` rule.

Add the missing `customer_refund` branch in the same pass so the guard's
whitelist becomes true rather than aspirational.

### 2. Preview branch
Add `expense` (and `customer_refund`) to `preview_reversal_consequences_core`
so the sheet can show the GL lines to be reversed, the analytic distributions
and project cost entries that disappear, the employee payable being cancelled,
and a **warning when the expense is queued for payroll**.

### 3. Close the payroll cash leak
- `expense_void` clears `reimburse_via_payroll` (or refuses while queued, with
  a message pointing at un-queue) and records the decision in the audit row.
- `compute-payroll`'s reimbursement query filters out `voided` (and any
  non-`approved`/`paid`) expenses — defence in depth, since a run computed
  before the void must not pay it either.

### 4. Reason vocabulary and reason code persistence
- Extend `reversal_reason_codes.applies_to` to include `expense` for the
  generic codes (`data_entry_error`, `duplicate_document`, `wrong_amount`,
  `wrong_counterparty`, `test_transaction`, `other`).
- `expense_void` gains `p_reason_code`, calls `assert_reversal_reason`, and
  writes `void_reason_code`.

### 5. Governance parity
`expense_void` consults `reversal_approval_requirement('expense', …)` and
refuses while an approval is required and unsatisfied, exactly as the bill and
invoice writers do.

### 6. UI parity
Replace the bare `voidExpense(id)` menu action in `src/pages/Expenses.tsx` and
`ExpensePeekSheet` with a `VoidExpenseDialog` built the same way as
`VoidBillDialog`: intent → consequence preview → shared reason field →
approval notice → confirm. No new reason list; it uses
`useReversalReasonCodes("expense")`.

### 7. Ratchet the guard so this cannot recur
Change `reversal-intent-coverage.test.ts` from a hand-written whitelist to a
check that scans the intent dispatcher and its resolvers in the migration
history for a branch per registered document type. A registry entry with no
server branch then fails CI for the right reason.

## Technical notes

- Migrations: one for the intent/preview branches, one for the reason codes +
  `expense_void` signature change (additive default so existing callers keep
  working), applied through the migration tool.
- No change to `post_expense_gl` or the posting monopoly; `expense_void`
  continues to reverse through `void_journal_entry_atomic`.
- `expense_void` currently has no explicit fiscal-period guard — the intent
  branch reports `period_open` and the writer will refuse a closed period,
  matching the other void writers.
- Regression surface to re-run: expense posting guards, reversal register
  coverage, reversal writer monopoly, reversal intent coverage, and the payroll
  reimbursement path.
