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

Here's where things stand.

Verified as genuinely done: the Cash & Bank Accounts screen no longer asks for the retired provider link, the Expenses screen (list, record/edit, void with reason, sidebar entry) is in place, and every status change goes through the existing server-side accounting commands. I also confirmed in the live database that the two earlier blocking defects are gone — the leftover supplier rule on expenses no longer exists.

Added this session:

A Categories button on the Expenses screen so you can create, note and retire expense categories, each with an optional default expense account.
An expense detail page (open it from a row's menu → View details) showing the summary, the history trail — recorded, submitted, approved, voided — the void reason, and a link to the ledger entry once it exists.
Both compile cleanly.

Still unfinished: the end-to-end rehearsal (record → approve → check the ledger entry → void → check the reversal) has not been run, so the posting path remains unconfirmed in practice, and no signed-in walkthrough was possible. Credits ran out, so continuing that verification needs available credits.