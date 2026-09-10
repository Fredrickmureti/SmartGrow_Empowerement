# Fix bank accounts error + add expense recording

## 1. Cash & bank accounts error (orphaned ERP leftover)

Confirmed cause: the bank accounts screen still asks the database to join each account to a
platform "bank provider" catalogue. That catalogue table was removed when the old ERP pieces were
retired, so the database rejects the whole request and no accounts load at all.

Fix:
- Stop requesting the provider join when loading bank accounts (`src/hooks/useBankAccounts.ts`).
- Remove the provider logo lookup on the account card (`src/components/banking/BankAccountCard.tsx`),
  falling back to the existing bank-name display.
- Leave the already-stubbed provider hook alone; nothing else references the removed table.

No database change is needed. This is a read-path fix only.

## 2. Expense recording

The expense engine already exists in the database (expenses, categories, attachments, and the
server commands for submit / approve / reject / void / post to the ledger), plus a client hook
`useExpenses` and `expenseCommands`. What is missing is the screens and the menu entry — nothing
in Finance links to it.

Build, reusing the existing record/list design-system patterns used by journal entries:

- **Expenses list** at `/finance/expenses`: date, number, category, payee/description, amount,
  status, with search, status filter and a "New expense" button.
- **Record expense** page: date, category, description, amount and currency, tax treatment,
  who paid (institution account vs. employee), the paying cash/bank account, reference,
  optional receipt attachment.
- **Expense detail**: read-only summary, lifecycle timeline (submitted / approved / posted /
  voided), the linked ledger entry, and the actions the current status allows —
  Submit, Approve, Reject, Void — each calling the existing server command, never writing
  status or amounts from the browser.
- **Edit** allowed only while the expense is still in an editable status.
- Add "Expenses" to the Finance sidebar under Operations, and register the routes.

Permissions follow the existing permission framework already used across Finance; approval uses
the existing server-side approval routing, so no new authorisation logic is introduced.

## Verification
- Cash & bank accounts loads without the failed request, accounts and balances visible.
- Record an expense, submit it, approve it, and confirm the ledger entry appears and the trial
  balance moves; then void one and confirm the reversal is registered.
- Typecheck clean.

## Out of scope
Employee payroll reimbursement queueing (no payroll in this system) and converting an expense
into a supplier bill — both engine paths stay unused.

=================IMPLEMENTATION PROGRESS/WHERE THINGS STAND================

Credits ran out mid-way, so I've stopped here. Where things stand:

Verified as done (the previous agent's claims hold)

Finance → Expenses exists: the list screen, the record/edit form, the void-with-reason dialog, the sidebar entry and the route are all in place, and every status change goes through the existing server-side accounting commands.
Cash & bank accounts: the obsolete provider link is genuinely gone from the code, so that screen's failed request is fixed.
Fixed during testing (two real production defects that made expenses unusable)

Recording any expense failed outright: a leftover supplier check on the expenses table pointed at a rule and supplier tables that were removed with the old ERP. That orphaned check has been removed.
Approving an expense failed: the ledger-posting rule still referred to retired project-tracking fields. It now posts without them, using the same single posting engine as everything else.
Not finished

The end-to-end rehearsal (record → approve → check the ledger entry → void → check the reversal) was interrupted right after the second fix, so it has not yet been confirmed to run clean. No test data was left behind — the test was designed to undo itself, and nothing was written.
There are no expense categories set up yet, so the first real expense will fall back to the default operating-expense account.
A dedicated expense detail page with a lifecycle timeline is still open.
Continuing needs available credits; the next step is simply to re-run the self-undoing test and confirm the ledger lines and the reversal.

ALSO IF EXPENSE CATEGORIES CREATION IS NOT EXPOSED IN THE UI it needs to be exposed in the ui 