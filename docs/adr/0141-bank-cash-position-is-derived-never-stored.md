# ADR 0141 — A bank balance is derived, never stored

Status: Accepted
Date: 2026-08-18
Related: ADR-0123 (single journal posting monopoly), ADR-0136 (one FX engine; a
missing rate is an absence)

## Context

`bank_accounts.current_balance` existed from the first banking migration and was
rendered as "Balance" on the bank account card, the finance dashboard, the bank
balance widget, the GL intelligence panel and the executive stats block.

No trigger, RPC, edge function or engine ever wrote it. Statement ingestion
(`bank_statement_import_batch`) does not touch it; the reconciliation lifecycle
does not touch it; `post_journal_entry_atomic` does not touch it. Every value in
that column was whatever a long-removed client write had once put there.

The consequence is worse than a wrong number: the figure was unfalsifiable. A
controller could not reconcile it to a statement line or a journal line, so
neither agreement nor disagreement with the ledger meant anything.

## Decision

1. **The column is gone.** `bank_accounts` stores the account's *identity*,
   *lifecycle* and *opening balance* — the three things a human actually
   asserts. It stores no running total.
2. **One projection answers "how much".**
   `public.bank_account_positions(_business_id, _as_of)` returns, per account:
   `opening_balance`, `statement_balance` (opening + the account's own
   `bank_transactions` up to `_as_of`), `last_statement_line_date`,
   `gl_balance` (posted journal lines on the linked control account),
   `gl_shared`, `unreconciled_count` and `unreconciled_amount`.
3. **Attribution is explicit.** When several bank accounts point at one control
   account, `gl_balance` is `NULL` and `gl_shared` is `true`, because the
   ledger balance genuinely cannot be attributed to a single account. We say so
   rather than divide it arbitrarily.
4. **SECURITY INVOKER.** The projection is a read model, not a seam. RLS on
   `bank_accounts`, `bank_transactions` and the journal tables decides what a
   caller sees; the function adds no privilege. `anon` cannot execute it.
5. **An unresolvable balance renders as `—`.** `resolveBankAccountBalance()`
   returns `null`, never `0`. This is ADR-0136's rule for missing FX rates
   applied to cash: absence is information, a fabricated zero is a lie.
6. **The two figures stay distinguishable.** The UI labels the number
   "Book Balance (GL)" or "Statement Balance". The gap between them is the
   reconciliation, so collapsing them into one anonymous "Balance" destroys the
   only signal a reconciler needs.

## Consequences

- Bank cards, the dashboard, the widget and the executive KPIs now show a
  ledger- or statement-derived figure, or an em dash. Accounts with no GL link
  and no imported statement show `—` where they previously showed a stale
  number — the intended, honest behaviour.
- Adding a new "cash" surface means calling the projection, not adding another
  denormalised column.
- Ratchet: `src/test/architecture/banking-balance-provenance.test.ts` fails CI
  on any reintroduced `bank_accounts.current_balance` read or write, on a
  `useBankAccounts` that stops resolving through the projection, and on a
  resolver that returns `0` instead of `null`.
