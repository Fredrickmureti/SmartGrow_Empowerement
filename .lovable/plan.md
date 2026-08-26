# Consolidation — living build record

## Brick status

| Brick | Scope | Status |
| --- | --- | --- |
| 0 | Cross-company comparative P&L on the authoritative GL engine | Done, with debt (B0-1 … B0-3) |
| 1 | Consolidation groups, membership, ownership, methods, audit, RLS | Done, with debt (B1-3) |
| 2 | Consolidated trial balance over a group | Done |
| 2b | Brick 0 debt closure (single P&L definition, finance-permission gate) | **Done this pass** |
| 3 | FX translation and CTA (IAS 21 / ASC 830) | Blocked on Brick 2 sign-off |
| 4 | Intercompany identification and eliminations | Blocked |
| 5 | Consolidated statements, drill-down, persisted runs | Blocked |

## Brick 2 — what was built

Database (migration applied):
- `resolve_consolidation_scope(_group_id, _as_of)` — SECURITY INVOKER. Resolves the
  effective-dated membership, returns ownership, method, member base currency, and a
  `blocker` per member (`equity_method_not_supported_yet`,
  `currency_translation_required`, `member_has_no_base_currency`,
  `ownership_percent_missing`). Raises `42501` when the group is invisible or when the
  caller cannot see every member — a partial scope is refused, never narrowed.
- `consolidation_scope_member_count(_group_id, _as_of)` — the only SECURITY DEFINER
  piece; it exists solely so an RLS-hidden member can be detected and the run refused.
  Returns a count, no row data. Anon execute revoked.
- `get_consolidated_trial_balance(_group_id, _date_from, _date_to)` — SECURITY INVOKER.
  Per member, per account: opening balance, period debit/credit, closing balance, taken
  only from `get_ledger_opening_balances` and `get_account_movements`. No second ledger
  engine, no direct journal-line queries. Refuses on any scope blocker and on an
  inverted date range.

Client:
- `src/hooks/finance/useConsolidatedTrialBalance.ts` — thin RPC wrappers plus
  `groupTrialBalanceByAccount` (regrouping only) and `nonControllingShare` (disclosure).
- `src/pages/reports/ConsolidatedTrialBalance.tsx` — group + period picker, scope panel
  with plain-English blockers, combined trial balance with optional per-company
  contribution rows, debit/credit balance check, NCI disclosure. Route
  `/reports/consolidated-trial-balance`, registered in `ReportRegistry`.

Accounting rules honoured:
- Controlled members combine at 100 % (IFRS 10 / ASC 810); the minority share is
  disclosed, never netted into group figures.
- Equity-method members are refused, not approximated — acquisition and
  post-acquisition data does not exist yet.
- Mixed presentation/base currency is refused — translation and CTA are Brick 3.
- Intercompany balances are **not** eliminated and the report says so on screen.

Security:
- One authorization decision per run: group visibility + every-member visibility in
  `resolve_consolidation_scope`, plus the finance read checks already inside the
  authoritative ledger RPCs (preserved by using SECURITY INVOKER).
- UI rail: `finance.view_consolidated`. The database remains authoritative.

Tests:
- `src/test/architecture/consolidated-trial-balance.test.ts` — 9 tests, passing.
- `supabase/tests/consolidated_trial_balance_test.sql` — database invariants
  (invoker/definer split, grants, no second ledger engine, refusal paths).

## Brick 2b — Brick 0 debt closure (this pass)

- **B0-1 closed.** New `public.get_gl_pnl_totals(_org_id, _date_from, _date_to,
  _business_id, _branch_id)` (SECURITY INVOKER, anon revoked) computes revenue,
  expenses and net profit in the database from `get_account_movements`, using the
  reporting normal-balance convention. `src/services/gl/fetchGLTotals.ts` is now a thin
  RPC wrapper: no account fetch, no account-type switch, no movement summation in the
  browser. Consumers unchanged and still typecheck: finance dashboard, sales dashboard,
  executive stats, GL intelligence, cross-company comparative.
- **B0-3 closed.** `src/pages/reports/Consolidation.tsx` now gates on the
  `finance.view_consolidated` permission (the same predicate the ledger RPCs enforce)
  instead of `owner`/`super_admin`, and never renders a denial while the permission is
  still loading.
- Guard tests: `src/test/architecture/gl-totals-single-source.test.ts` (4 tests, passing).

## Outstanding debt

- **B1-3 / B2-1**: neither `supabase/tests/consolidation_group_foundation_test.sql` nor
  `supabase/tests/consolidated_trial_balance_test.sql` has been executed — the sandbox
  has no reachable Postgres and the read-query role cannot execute the revoked
  functions. Run both against a real database before Brick 3.
- **B2-2**: `get_gl_pnl_totals` and `get_consolidated_trial_balance` have not been run
  against real posted data (no consolidation group exists in the connected project yet).
  Before Brick 3, create a group with two same-currency members, post entries, and
  confirm: dashboard revenue/expenses unchanged versus the P&L statement, and the
  consolidated trial balance equals the sum of the members' own trial balances.
- Brick 2 has no persisted run/snapshot — deliberate; that is Brick 5.

## Currently active / next up

- Active phase: none in flight — Brick 2 and its Brick 0 debt closure are complete.
- Next milestone: **Brick 3 — FX translation and CTA**, gated by the entry criteria below.

## Handover for the next agent

1. **Verify before building.** Re-read this file, then confirm against the live system:
   `resolve_consolidation_scope`, `consolidation_scope_member_count`,
   `get_consolidated_trial_balance` and `get_gl_pnl_totals` exist with the stated
   security modes and grants; `fetchGLTotals.ts` contains no accounting arithmetic;
   the comparative page gates on `finance.view_consolidated`. Run
   `bunx vitest run src/test/architecture/consolidat` and
   `src/test/architecture/gl-totals-single-source.test.ts`.
2. **Clear B2-1 and B2-2** (execute the two SQL suites; validate against real posted
   data). Do not start Brick 3 until the consolidated trial balance has been reconciled
   to member trial balances at least once.
3. **Then resume chronologically at Brick 3** — no unrelated work, no Brick 4/5
   placeholders, no client-side FX arithmetic.

## Brick 3 entry criteria

Brick 2 signed off on real data (a group with two same-currency members and posted
entries), SQL invariant suites executed, then design FX translation: rate resolution
through the existing FX engine only, closing rate for assets/liabilities, average for
P&L, historical for equity, CTA as a real equity component.
