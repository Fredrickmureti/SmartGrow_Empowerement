# Banking & Reconciliation — currency context audit and repair

## What was actually verified this turn

Evidence gathered by reading source and querying the live database. Nothing below is inferred from UI behaviour alone.

### 1. The root cause is a shared formatter with a USD default

`src/lib/utils.ts`:

```text
export function formatCurrency(amount: number, currency: string = "USD")
```

Every banking surface that imports this helper and calls it with one argument renders USD, regardless of workspace, account or document currency. Confirmed one-argument callers in the banking/reconciliation domain:

- `src/features/finance/reconciliation/ReconcileTransactionSheet.tsx` (the Match drawer — invoice, bill, expense, journal candidate amounts)
- `src/features/finance/reconciliation/TransferReconcileSheet.tsx` (Record bank transfer)
- `src/pages/BankReconciliation.tsx` (transaction rows, session summary lines, unreconcile confirm)
- `src/components/banking/TransactionsList.tsx`
- `src/pages/BankFeeds.tsx`

So this is not one hardcoded `$` in one drawer — it is one canonical layer with a wrong default, consumed by five banking surfaces.

### 2. A second, correct formatter already exists

`useCurrency().formatCurrency(amount, code?)` in `src/contexts/CurrencyContext.tsx` defaults to the business `base_currency` and honours `currencies.decimal_places`. It is already used correctly by `ReconciliationWorkspace.tsx`, `ReconciliationHistoryTab.tsx`, `BankAccountCard.tsx`, `AccountRegister.tsx`.

The banking domain therefore has **two money formatters with different defaults** — that drift is the architectural defect.

Caveat found: `CurrencyContext` seeds `baseCurrency` from `localStorage` with a literal `"USD"` before the business loads. Display-only, but it is a second silent USD source.

### 3. Currency does exist all the way down — it is dropped at the last hop

Verified schema:

- `bank_accounts.currency` — the authoritative currency of a bank line (single account in this workspace: `KES`, `active`).
- `bank_transactions.amount` is in the account currency; `bank_transactions.original_currency` + `exchange_rate` exist for foreign-origin lines.
- `bank_reconciliation_sessions` has no currency column — correct; a session inherits its account's currency.
- `invoices.currency`, `bills.currency` (+ `currency_rate`, `company_currency_total`), `expenses.currency` all exist.

So no data is missing. The sheets simply never read `bank_accounts.currency` or the candidate's own `currency` and never pass anything to the formatter.

### 4. Record bank transfer — the selector is a genuine empty state, not a bug

Database check: the workspace has exactly **one** bank account. `TransferReconcileSheet` filters `a.id !== transaction.bank_account_id`, which correctly yields zero options — but renders an empty dropdown with a "Select bank account" placeholder and no explanation, no loading state, no error state.

Also verified from `reconcile_bank_transfer_atomic`: the server **refuses** a cross-currency transfer (`BANK_TRANSFER_CURRENCY_MISMATCH`, ADR 0136 — no 1:1 mirror). The UI does not filter by currency, so an operator with a USD and a KES account can select an ineligible destination and only learn at submit.

### 5. The DR/CR hint is close but detached from the posting

The RPC posts: source txn `debit` → DR destination GL, CR source GL; source txn `credit` → DR source (this) GL, CR the other GL. The sheet's copy matches the direction but labels the same control "Transfer From" while calling the value `destBankAccountId` and describing it as "source account". The hint is static text, not derived from the selected accounts.

## Root causes (three, not one)

1. **Canonical formatter default** — `formatCurrency(amount, currency = "USD")` in `src/lib/utils.ts`, plus the `localStorage` `"USD"` seed in `CurrencyContext`.
2. **Currency context not propagated into the reconciliation sheets** — the account's currency is never read, and candidate documents' own `currency` is ignored.
3. **Transfer eligibility and empty state unmodelled in the UI** — the server's same-currency rule and the "no other account" case are both invisible until submit.

## Decision — canonical architecture

- The **bank account currency** (`bank_accounts.currency`, falling back to nothing — never a literal) is the authoritative currency for a bank transaction, a reconciliation session, and every figure on the bank side of the match drawer.
- A **candidate document is rendered in its own currency** (`invoice.currency` / `bill.currency` / `expense.currency`), never in the bank account's. When they differ, the candidate is flagged rather than silently reformatted — the client never converts a bookable amount (ADR 0136).
- All banking money rendering goes through **one formatter**: `useCurrency().formatCurrency`. `formatCurrency` from `@/lib/utils` is banned in the banking/reconciliation domain.
- Cross-currency matching/transfer stays **refused server-side**; the UI's job is to surface that rule early, not to implement FX.

## Repair scope (minimal, presentation + eligibility only)

No posting, matching or reconciliation accounting behaviour changes.

1. `src/lib/utils.ts` — drop the `"USD"` default; make `currency` required. Fix any resulting call sites by threading the real currency (banking first; anything outside banking that breaks gets the business base currency via context, not a literal).
2. `CurrencyContext` — remove the `"USD"` localStorage seed; treat "not yet known" as not-ready instead of guessing.
3. `ReconcileTransactionSheet` — accept/derive the bank account currency, format the transaction and totals with it; format each invoice/bill/expense candidate with its own `currency`; show a "different currency" badge on mismatched candidates and block selecting them (the seam would refuse anyway).
4. `TransferReconcileSheet` — format with the source account currency; restrict destinations to accounts sharing that currency; render four distinct states (loading / error / no other accounts / none in this currency); derive the DR/CR hint from the selected accounts and the actual posting direction; fix the "Transfer From" vs "destination" naming.
5. `BankReconciliation.tsx`, `TransactionsList.tsx`, `BankFeeds.tsx` — switch to `useCurrency().formatCurrency` with the account currency.

## Regression tests

- Extend `src/test/architecture/banking-currency-integrity.test.ts` to cover `src/features/finance/reconciliation`, `src/components/banking`, `src/pages/BankReconciliation.tsx`, `src/pages/BankFeeds.tsx`: no import of `formatCurrency` from `@/lib/utils`, no currency literal.
- Extend `no-silent-currency-fallback.test.ts` to catch a defaulted `currency =` parameter in shared formatters.
- Unit test: the same amount renders KES in a KES workspace and EUR in a EUR workspace from the same component — currency follows context, KES is never the hardcoded expected answer.
- Unit test: transfer sheet renders an explicit empty-state message when zero eligible destinations, and excludes a different-currency account from the options.

## Explicitly out of scope (follow-up)

- Cross-currency reconciliation/transfer with an FX entry — architecture currently refuses it by design; documented, not implemented.
- Sweeping the remaining ~300 non-banking `formatCurrency` call sites onto the context formatter.
- The Phase 5b banking FX-panel work still queued in `.lovable/plan/banking-wave-1-phase-5b-*`.

## Status

Investigation complete, evidence recorded above. Implementation not started — awaiting approval.
