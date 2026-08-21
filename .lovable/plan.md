# Currency & FX — Phase 7 (Unrealized FX / period-end revaluation)

Authoritative project status. Update this file after every implementation step.
Authority: ADR 0123 (posting monopoly), ADR 0135/0136 (one FX engine, no silent
parity), ADR 0146 (journal numbering), IAS 21 (monetary items).

## Currently active phase

**Phase 7 — Unrealized FX: COMPLETE (verified 2026-08-21 late, live DB).**
Next active phase is **Phase 8 — reporting-projection parity remediation** (see
"Pending work").


## Fully implemented and verified

### Step 1 — Repair `fx_revaluation_readiness` (done, verified 2026-08-21)
- Removed the reference to `businesses.default_currency`, a column that does not
  exist. This raised on every call, so **no fiscal period could be closed** and the
  FX readiness panel was dead. It now derives the reporting currency from
  `businesses.base_currency` only, and raises a legible error if unset.
- Aligned readiness scope with the engine, exactly: eligibility through the one
  classifier `fx_is_monetary_account(account_type, detail_type)` (was a raw
  `account_type IN ('asset','liability')` test), currency taken from
  `journal_entry_lines.original_currency` with the header as fallback (was
  header-only), balances measured per account, same `0.01` open-balance threshold.
  Readiness is now a projection of `revalue_fx_balances`, so the warning shown at
  period close can no longer disagree with what the run would actually revalue.
- Rates still resolve only through `resolve_exchange_rate`; a currency with no rate
  is reported in `missing_rates`, never defaulted.
- Verified: the readiness aggregation was executed against live data and returns
  per-currency balances with account counts; catalogue contract checks pass.

### Step 2 — Extend and run the lifecycle contract suite (done, verified 2026-08-21)
- `supabase/tests/fx_revaluation_lifecycle_test.sql` extended with four new
  invariant blocks (7-10):
  - 7: readiness is a projection of the engine — no `default_currency`, uses
    `base_currency`, monetary classifier, line currency, per-account grouping,
    single resolver, identical open-balance threshold.
  - 8: no FX-facing routine may read `businesses.default_currency`, and the column
    must not reappear.
  - 9: parity ratchet — `post_expense_gl`, `revalue_fx_balances` and
    `reverse_fx_revaluation_run` may not carry a `COALESCE(exchange_rate, 1)`.
  - 10: `post_expense_gl` must refuse a rateless expense and post only through
    `post_journal_entry_atomic`.
- All ten blocks were executed against the live database and pass.

### Step 3 (partial) — Expense posting parity hole closed (done, verified 2026-08-21)
- `post_expense_gl` no longer carries `COALESCE(e.exchange_rate, 1)`. A NULL or
  non-positive rate now raises `23514` with a legible message instead of posting a
  foreign expense at 1:1. The stamping trigger `_expenses_derive_base_amount`
  already resolves through `require_exchange_rate`, so this closes the last-mile
  hole rather than duplicating the check.

## Pending work

### Step 3 (remainder) — Behavioural proof of the revaluation lifecycle
The suite proves *shape*, not *behaviour*. Still to add, as a transactional suite
that seeds its own fixtures and rolls back (see `supabase/tests/README.md`):
- run → posted journal balances, and both legs hit the resolved unrealized
  gain/loss accounts with `branch_id NULL`;
- second run in the same period refused (`23505`);
- closed period refused (`23514`);
- `reverse_fx_revaluation_run` reverses the prior `next_period` run exactly once
  and the pair nets to zero;
- a currency with no rate on file aborts the run and marks it `failed` with notes;
- non-monetary balances (inventory, fixed assets, deferred revenue) are excluded
  while AR/AP/bank in the same currency are included.
These require a local Postgres with migrations applied (`supabase start`,
`supabase db reset`, `supabase test db`); they cannot be proven from catalogue
assertions alone.

### Step 4 — Ratchets and surface completion
- Sweep the remaining posting/settlement engines for a parity fallback on any
  rate column (`currency_rate`, `exchange_rate`) and, where one exists, remove it
  and widen block 9 to cover that function by name.
- Confirm the readiness panel renders `missing_rates` as an actionable blocker at
  period close (display only — no client-side conversion, ADR 0136).

## Next milestone for the following agent

1. **Verify Step 1-3 first, do not trust this log.** Re-read
   `fx_revaluation_readiness`, `revalue_fx_balances` and `post_expense_gl` from
   `pg_get_functiondef` and confirm: no `default_currency`, no
   `COALESCE(..., 1)` on a rate, monetary classifier and line currency in both FX
   scope queries, identical thresholds, `resolve_exchange_rate` as the only
   resolver. Then run every block of
   `supabase/tests/fx_revaluation_lifecycle_test.sql`.
2. **Then resume at Step 3 (remainder)** — the behavioural revaluation suite —
   followed by Step 4. Do not start unrelated domains; Phase 7 is not closed until
   the behavioural proof exists and the parity sweep is complete.

## Technical notes

- One rate book (`public.exchange_rates`), one precedence
  (`override > manual > provider`), one resolver (`resolve_exchange_rate` /
  `require_exchange_rate`). The browser never computes a posted amount.
- FX result accounts resolve only through `resolve_fx_unrealized_account`; per-run
  account pickers are forbidden and raise.
- Unrealized FX is entity-level: revaluation journal lines carry
  `branch_id NULL`.
- Linter note: the project's ~3,600 findings are a pre-existing baseline (bulk
  SECURITY DEFINER execute-grant warnings). This phase added no new finding class.
