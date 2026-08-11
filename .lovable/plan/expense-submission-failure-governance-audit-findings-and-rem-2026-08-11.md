# Expense Submission Failure — Governance Audit Findings and Remediation

## H. Architectural verdict (up front)

**Is Expense correctly integrated with the Governance engine? YES.**
The 400 is **not** a governance failure. Governance resolved correctly under SOLO, the
expense was auto-approved ungated, and the transaction then failed in **GL posting**
because the payment account the form offered is a **header (group) account**.

## D. Exact root cause (from Postgres logs, not the HTTP status)

```
SQLSTATE: 23514
Message:  Cannot post to header account 1010/Cash and Cash Equivalents.
          Header (group) accounts are non-postable; pick a leaf child.
Raised in: prevent_journal_post_to_header() (trigger on journal_entry_lines)
Call stack:
  expense_submit(uuid) line 31
   -> _expense_apply_approval(uuid,uuid) line 9
     -> post_expense_gl(uuid) line 156
       -> post_journal_entry_atomic(...) line 61  [INSERT journal_entry_lines]
```

Evidence: the expense row `EXP-00001` (7,000 KES, company-paid) carries
`payment_account_id = 427a0e57…`, which is account **1010 "Cash and Cash Equivalents",
`is_header = true`**. The whole `expense_submit` transaction rolled back, which is why
the row is still `draft` with `submitted_by = NULL` — atomicity worked correctly.

## A. Governance architecture (as implemented)

- Mode lives on `organizations.governance_mode`. This org (`Joshua Holdings`) = **solo**.
- Two distinct mechanisms:
  1. **Gating** — `approval_route(action_key, …)` validates the key against
     `governance_action_registry`, then matches `approval_rules` via
     `_approval_match_rule`. If no rule matches and `requires_approval_always = false`,
     it **returns NULL — the action is not gated** and the caller proceeds immediately.
  2. **Self-action / SoD** — `governance_assert_not_self(actor, subject, action, org, …)`:
     - explicit `self_action_policy(action_key, applies_to_role)` wins in every tier;
     - else `solo` + owner/admin/super_admin → **allowed and audited**
       (`sod.self_action_auto_allowed`);
     - else `standard` + owner/admin → `warn` (audited, allowed);
     - else `block`, unless a live single-use `self_action_overrides` row is consumed.
     Precedence: **per-action policy > mode default > one-time override > block.**
- Registry rows exist for `expense.approve`, `expense.approve_self_benefit`,
  `expense.submit`, `expense.void`, `reversal.expense`.
- `approval_rules` for entity_type `expense`: **0 rows**. `self_action_policy` for any
  expense action: **none**. Effective policy for this test: **ungated + self-action allowed
  (solo)** → submit must post immediately. That is exactly what the code attempted.

## C / E. Actual lifecycle and Create-button flow

`ExpenseCreatePage` → `useExpensesPaginated.createExpense` → `INSERT expenses`
(status server-defaulted to `draft`) → `submitExpense(id)` → `rpc expense_submit`:
guard → `status = 'submitted'` → `approval_route('expense.approve', …)` → NULL (ungated)
→ `_expense_apply_approval` → `post_expense_gl` → **failed here** → whole txn rolled back
→ row stays `draft`. This is **Model B** (create-and-submit, SOLO resolves to approved),
which matches the RFQ reference implementation.

## F. Why "Submit for approval" is displayed

`src/pages/Expenses.tsx:1096-1100` renders the label purely from
`status === draft | pending | rejected`. It is **not** governance-aware. The correct
in-repo convention is `useRFQActions.tsx:104`, which labels the action
`"Submit & approve"` when `governanceMode === "solo"`. So the label is a real
context-awareness gap — cosmetic, not the cause of the 400.

## G. Known-good comparison

- **RFQ** — `rfq_submit_for_approval` → `approval_route('rfq.approve', …)`, stores
  `rfqs.approval_request_id`, mirrors via `_mirror_approval_to_rfq`; UI reads the
  `gated` flag and completes the transition in solo mode.
- **Bills / Purchase Orders** — same shape: module submit RPC routes, refuses its own
  approve RPC while a live request exists, mirror trigger writes the decision back.
Expense follows the identical contract (`_mirror_approval_to_expense` exists,
`approval_request_id` stored, `gated` returned). No second engine was introduced.

## Remediation (smallest architecture-correct fix)

1. **Stop offering non-postable accounts** (the actual defect).
   `src/features/purchases/expenses/usePaymentAccounts.ts` selects active asset/liability
   accounts with **no `is_header` filter**, so group headers such as 1010 appear in the
   picker. Add `.eq("is_header", false)` and select `is_header` so the fallback branch
   (used when the keyword filter matches nothing) is also safe.

2. **Fail fast and legibly on the server, before any partial work.**
   In `post_expense_gl`, validate the resolved expense/payment/input-tax accounts with the
   existing `_account_is_postable` helper and raise a governance-style, parseable error
   naming the offending account instead of letting the journal-line trigger surface deep
   in the stack. No governance behaviour changes.

3. **Surface the real error in the UI.**
   `src/pages/Expenses.tsx:632` already passes `normalizeError(error).message`, but
   `expenseCommands.call` rewrites only governance hints. Keep the PG message/hint/detail
   intact for non-governance errors and log the SQLSTATE to the console so the toast reads
   "Cannot post to header account 1010 …" rather than "something unexpected happened".

4. **Make the Expense action label governance-aware**, mirroring RFQ: show
   "Submit & approve" when the effective policy is ungated/solo, "Submit for approval"
   otherwise. Purely presentational; the server remains the decision-maker.

5. **Regression tests**
   - pgTAP: posting an expense whose payment account is a header raises the new
     explicit error and leaves the expense in `draft` with no journal entry (atomicity).
   - Unit test: `usePaymentAccounts` never returns `is_header` accounts.
   - Architecture test: expense lifecycle functions keep routing through
     `approval_route` / `governance_assert_not_self` (no module-local SoD logic).

## Explicitly not doing

No change to governance modes, `approval_route`, `governance_assert_not_self`,
`self_action_policy`, RLS, or the expense state machine. No auto-approval shortcuts, no
error suppression, no client-side status writes.

## Verification after the fix

Re-run under SOLO: create an expense with a leaf cash account → expects
`gated: false`, status `approved`, one balanced journal entry, one
`sod.self_action_auto_allowed` audit row. Then insert a temporary `approval_rules` row for
`expense` to confirm the gated path parks the expense in `submitted` with an
`approval_request_id`, and remove it.
