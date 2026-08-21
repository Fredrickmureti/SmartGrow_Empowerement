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

### Step 3 — Expense posting parity hole closed (done, verified 2026-08-21)
- `post_expense_gl` no longer carries `COALESCE(e.exchange_rate, 1)`. A NULL or
  non-positive rate now raises `23514` with a legible message instead of posting a
  foreign expense at 1:1. The stamping trigger `_expenses_derive_base_amount`
  already resolves through `require_exchange_rate`, so this closes the last-mile
  hole rather than duplicating the check.

### Step 3 (remainder) — Behavioural revaluation suite (done, written 2026-08-21)
`supabase/tests/fx_revaluation_behaviour_test.sql` seeds its own fixtures in a
self-aborting transaction and asserts behaviour, not shape:
- run → posted journal balances; both legs hit the resolved unrealized
  gain/loss accounts with `branch_id NULL` (entity-level, IAS 21);
- a second run in the same fiscal period is refused;
- a currency with no rate on file aborts the run — never parity;
- `reverse_fx_revaluation_run` nets the remeasurement to zero, exactly once;
- non-monetary balances excluded while AR/AP/bank in the same currency are in.
It runs under `supabase test db` on a local stack (`supabase start`,
`supabase db reset`); it is deliberately transactional so it leaves no residue.

### Step 4 — Parity sweep and ratchets (done, verified 2026-08-21 late)
- `purchase_return_create` was the last posting-path offender: it did a private
  lookup against `public.exchange_rates` then `COALESCE(v_rate, 1)`. It now
  resolves through `require_exchange_rate`, so a rateless foreign return refuses.
- Block 9 of the lifecycle suite is now a **global** sweep over every public
  function (comments stripped) for `COALESCE(<rate>, 1)`, and block 11 pins
  `purchase_return_create` to the resolver by name.
- Sweep executed against the live database: **zero posting, settlement,
  revaluation or document engine carries a parity fallback.**

## Pending work

### Phase 8 — reporting-projection parity remediation (next, active)
The global sweep found six **read-only reporting** functions that still translate
a document total with `COALESCE(NULLIF(rate, 0), 1)`:
`finance_purchase_analysis`, `finance_purchase_expense_reconciliation`,
`finance_sales_analysis`, `finance_sales_revenue_reconciliation`,
`get_salesperson_performance`, `get_salesperson_performance_documents`.
They post nothing, so the ledger is safe, but they report a rateless foreign
document as though it were base currency — ADR 0136 says an absent rate is an
absence. They are listed by name as an explicit exemption in block 9 so the
ratchet cannot widen silently and no new function can join them.

Remediation, one function per migration (small, reversible — the database has
been sensitive to large migrations):
1. Replace each fallback with the resolved rate (`resolve_exchange_rate`, NULL
   allowed) and return a NULL/flagged figure plus an `unrated_count` rather than
   a parity-valued number.
2. Surface that flag in the consuming report UI as "excludes N unrated foreign
   documents" — display only, no client-side conversion.
3. Remove the function from the block 9 exemption array as each is fixed; the
   array must reach empty.

### Phase 9 — surface confirmation
- Confirm the readiness panel renders `missing_rates` as an actionable blocker at
  period close (display only, ADR 0136).
- Isolation ratchet: assert business-scoping on `fx_exposure_by_currency`,
  `fx_exposure_open_items`, `fx_revaluation_readiness`, `describe_exchange_rate`.

## Next milestone for the following agent

1. **Verify Phase 7 first, do not trust this log.** Re-read
   `fx_revaluation_readiness`, `revalue_fx_balances`, `post_expense_gl` and
   `purchase_return_create` from `pg_get_functiondef` and confirm: no
   `default_currency`, no `COALESCE(..., 1)` on a rate, monetary classifier and
   line currency in both FX scope queries, identical thresholds, and
   `resolve_exchange_rate` / `require_exchange_rate` as the only resolvers. Then
   run every block of `supabase/tests/fx_revaluation_lifecycle_test.sql` and the
   behavioural suite on a local stack.
2. **Then start Phase 8** — the reporting-projection remediation above, one
   function per small migration, emptying the block 9 exemption array as you go.
   Then Phase 9. Do not start unrelated domains.

**Migration discipline (operational, learned the hard way):** keep migrations
small and single-purpose — one function per migration. Large multi-object
migrations have destabilised this database and forced a project restart.


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
