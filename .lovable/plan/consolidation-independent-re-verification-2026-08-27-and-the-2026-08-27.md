# Consolidation — independent re-verification (2026-08-27) and the work to close Brick 3

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected;
no connection work is needed.

The previous plan file in this repo is **materially out of date and wrong in two places**.
Everything below was checked directly against the live database and the files in this
session. Nothing is carried over on trust.

## Phase 1 — verified current state

### Confirmed correct (previous claims that hold)

- **No second accounting engine.** `get_consolidated_trial_balance`,
  `get_gl_pnl_totals` and `consolidation_translate_member` all read the authoritative
  ledger primitives `get_account_movements` and `get_ledger_opening_balances`.
- **Brick 1 is genuinely done.** `src/services/gl/fetchGLTotals.ts` calls
  `get_gl_pnl_totals`; the comparative page (`src/pages/reports/Consolidation.tsx`)
  contains no accounting arithmetic of its own and sums nothing across companies.
- **Scope security is server-side.** `resolve_consolidation_scope` compares the
  member rows the caller can see against `consolidation_scope_member_count`
  (the single SECURITY DEFINER piece) and refuses the whole report when the caller
  cannot access every company in scope. Blockers exist for equity method, missing
  base currency, missing ownership, missing CTA account, and thin rate coverage.
- **Grants are correct.** Every consolidation function is EXECUTE to `authenticated`
  and `service_role` only — no `anon`.

### Previous claims that are FALSE

1. **"`consolidation_translate_member`, `get_consolidated_trial_balance_translated`
   and `consolidation_cta_reconciliation` do not exist."** All three exist in the
   database now, with the full closing/average/historical rate classing and a CTA
   residual line. Step B of the old plan largely landed after that text was written.
2. **"Repo/database drift: only one consolidation migration file exists."** False.
   The Brick 2 and Brick 3 objects were applied through the migration tool and are in
   `supabase/migrations/` under hash-named files (`20260826204139…`, `20260826204315…`,
   `20260826204737…`, `20260827023602…`, `20260827023959…`). The schema is reproducible.
   No drift-repair work is needed, and issuing "reconciling" migrations would be
   busywork.
3. **"Build a persistent parent+subsidiary fixture in the tenant."** Unnecessary and
   undesirable: the three SQL suites in `supabase/tests/` already seed their own
   organizations, companies, accounts and posted entries inside a DO block and roll
   back. Validation should extend those, not pollute the live tenant.

### Real remaining gaps (verified)

- **The translated path has no UI at all.** No file outside the generated types
  references `get_consolidated_trial_balance_translated`, `consolidation_cta_reconciliation`,
  `cta_account_id` or `rate_class`. `ConsolidatedTrialBalance.tsx` still calls only the
  untranslated RPC and still tells the user "no FX translation / CTA". Group settings
  (`src/components/settings/ConsolidationGroupsSettings.tsx`,
  `src/hooks/finance/useConsolidationGroups.ts`) cannot select a CTA account — the hook
  does not even fetch the column. So a mixed-currency group can be created that is
  permanently blocked with no way for the user to fix it.
- **The invariant suites have still never been executed.** Brick 2 remains
  "built but unvalidated", and the translated path has no tests whatsoever.
- **Only one group with one member exists** (presentation currency KES,
  `cta_account_id` NULL); both companies in the tenant are KES, 17 journal entries.
  No translation path has ever run against real data.
- **Accounting defects found by reading `consolidation_translate_member`:**
  - The CTA residual is summed over **every** account including nominal ones, so the
    residual mixes the P&L translation difference into a balance-sheet reserve without
    routing it through retained earnings. Needs an explicit decision and a test.
  - Equity movements are translated at a single `historical_rate` taken from the
    member's `historical_rate_date`/`effective_from`, so share capital issued *during*
    the period is translated at the wrong rate (IAS 21 wants the transaction-date rate).
  - `consolidation_cta_reconciliation` reports `movement = closing − opening` from the
    same query that produced both — a tautology that cannot detect an error. It must
    instead prove the residual equals the independently computed translation difference
    (opening net assets × rate change + period result × (closing − average)).

## Phase 2 — additions to the plan

- Treat "the database can do it but nothing in the product exposes it" as an unfinished
  brick, not a finished one. Brick 3 does not close until a user can configure CTA and
  read a translated statement.
- Add an architecture test that fails if the translated RPC exists but no hook consumes
  it, mirroring the existing `consolidated-trial-balance.test.ts` pattern — this class of
  half-landed work must be caught automatically.
- Validation runs as self-contained, self-rolling-back SQL suites. The live tenant stays
  clean.

## Work order

### Step A — validate what exists (blocking, no new features)
- Execute the three existing suites (`consolidation_group_foundation_test.sql`,
  `consolidated_trial_balance_test.sql`,
  `consolidated_trial_balance_reconciliation_test.sql`) and fix whatever they surface.
- Confirm the refusal paths actually refuse: inaccessible member, mixed currency on the
  untranslated report, equity-method member, inverted date range, missing ownership.
- Record results in this file. Nothing else proceeds until this passes.

### Step B — correct the translation accounting
- Decide and implement the nominal-account treatment: P&L translated at average, its
  translation difference carried to CTA through the period result rather than swept in
  anonymously; opening retained earnings at prior closing rate.
- Replace the single historical equity rate with per-movement transaction-date
  translation for equity, keeping the member's historical date for opening equity.
- Rewrite `consolidation_cta_reconciliation` as a genuine independent check
  (opening net assets × rate change + result × rate spread = CTA movement), so a
  mismatch is an error, not arithmetic identity.
- Keep reusing `fx_rate_on`, `fx_period_average_rate`, `resolve_exchange_rate` and
  `fx_is_monetary_account`. No competing rate resolver.

### Step C — configuration surface (makes mixed-currency groups usable)
- `useConsolidationGroups` fetches and writes `cta_account_id` and
  `historical_rate_date`.
- Group settings gains CTA equity-account selection, restricted to active, postable
  equity accounts of the parent company, plus the per-member historical rate date.
- Saving a mixed-currency group without a CTA account is refused with the reason.

### Step D — reporting surface
- `ConsolidatedTrialBalance` gains presentation-currency columns, per-member translated
  figures, the rate class and rate applied per line, and the CTA line; the stale
  "no FX translation" copy is removed.
- Add a CTA reconciliation panel driven by the RPC.
- Zero FX arithmetic in TypeScript: the browser renders what the database computed.

### Step E — translated-path tests
New self-contained suites: same-currency group (translation is a no-op and totals are
unchanged), parent KES / subsidiary USD with posted entries in each, rate-coverage gap
refusal, missing-CTA refusal, CTA reconciliation, closed-period behaviour, and the
architecture test that the translated RPC is actually consumed by the app.

Explicitly out of scope until Brick 3 closes: intercompany identification, eliminations,
consolidated cash flow, persisted consolidation runs, minority interest, equity method.
