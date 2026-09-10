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

Verified as genuinely done: the Cash & Bank Accounts screen no longer requests the retired provider link, and the Expenses screens (list, record/edit, categories, detail with history, void with reason) plus the Finance menu entry and routes are all in place, with every status change going through the existing server-side accounting commands.

Fixed this session — two real blockers that made expense posting impossible in production:

The posting routine called an account-validity check in a form that did not exist, so approving an expense failed outright.
It also called the central ledger-posting routine with the wrong set of arguments. I rewrote it to pass date, reference, description, currency, rate and branch correctly, still posting through the one shared ledger routine, and it now also validates the paying cash/bank account.
Still untested: the rehearsal reached the void step and stopped there because two versions of the void command exist, so the call was ambiguous — my test script needs the version stated explicitly. That means record → submit → approve → ledger entry is now unblocked but not yet confirmed end to end, and void/reversal remains unverified. Credits ran out, so finishing that rehearsal needs available credits.