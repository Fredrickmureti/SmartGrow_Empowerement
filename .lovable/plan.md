# Consolidation — verification verdict (2026-08-26 late) and the work to finish Brick 3

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already
connected. No connection work is needed.

## Phase 1 — what I verified directly against the live database and files

Every claim below was checked in this session; none is carried over on trust.

Confirmed present and real:
- Functions: `resolve_consolidation_scope`, `consolidation_scope_member_count`
  (the one SECURITY DEFINER piece), `get_consolidated_trial_balance`,
  `get_gl_pnl_totals`, all reading the existing ledger engine
  (`get_account_movements`, `get_ledger_opening_balances`). No second accounting engine.
- Brick 3 partials that were applied: `fx_rate_on`, `fx_period_average_rate`,
  `_consolidation_fy_start`, `consolidation_member_translation_rates`,
  `_consolidation_cta_account_guard`, plus the columns
  `consolidation_groups.cta_account_id` and
  `consolidation_group_members.historical_rate_date`.
- UI: consolidation group settings, `ConsolidatedTrialBalance`, the comparative
  `Consolidation` page.
- Test files on disk: `consolidation_group_foundation_test.sql`,
  `consolidated_trial_balance_test.sql`,
  `consolidated_trial_balance_reconciliation_test.sql`.

Confirmed still missing — the previous notes were accurate that the run was cut off:
- `consolidation_translate_member`, `get_consolidated_trial_balance_translated`
  and `consolidation_cta_reconciliation` **do not exist** in the database.
- `resolve_consolidation_scope` still hard-blocks with `currency_translation_required`,
  and has no `cta_account_not_configured` blocker.
- The database is therefore in a half-built state: new rate functions exist and
  nothing consumes them. Safe for users (untranslated report unchanged), incoherent
  as architecture.

Corrections to the previous plan's own claims:
- It said 0 groups / 0 members. There is now **1 group** ("Joshua Holdings Group",
  presentation currency KES, `cta_account_id` NULL) with **1 member**, method `full`,
  100% ownership. That is not a validation fixture — a one-member same-currency group
  proves nothing about consolidation.
- Both businesses in the tenant are KES, 17 journal entries / 37 lines. There is no
  foreign-currency subsidiary anywhere, so no translation path has ever run.
- Repo drift: only one consolidation migration file exists
  (`20260826200409_consolidation_grant_tightening.sql`). Everything else applied in
  Bricks 2 and 3 lives in the database with no migration in the repo. This must be
  corrected or the schema is unreproducible.
- Brick 2 remains **built but unvalidated** — the invariant suites have still never run.

## Phase 2 — what I am adding to the plan

1. **Repo/database drift is a defect, not paperwork.** Every consolidation object now
   living only in the database must be reissued through migrations so the schema is
   reproducible. This is prerequisite work, not cleanup.
2. **A one-member group is not a fixture.** Validation needs a genuine parent +
   subsidiary set, and a second set with a non-KES subsidiary, or FX translation can
   never be verified.
3. **CTA needs a named equity account before translation may run.** `cta_account_id`
   is nullable and currently NULL; translation must refuse rather than plug a residual
   into thin air.
4. Reuse the existing `fx_is_monetary_account` and `resolve_exchange_rate`; no
   competing rate resolver.

## Work order

### Step A — reproducibility and validation of what exists (Brick 2V, blocking)
- Reissue every consolidation object currently only in the database as proper
  migrations (tables/columns already applied are reconciled idempotently).
- Execute all three SQL invariant suites and fix whatever they surface.
- Build a real same-currency fixture: parent plus a second member, posted journal
  entries in each. Reconcile the consolidated trial balance against the arithmetic
  sum of each member's own trial balance; debits must equal credits.
- Confirm `get_gl_pnl_totals` matches the P&L statement for the same period/scope.
- Confirm the refusal paths refuse: inaccessible member, mixed currency,
  equity-method member, inverted date range.
- Record results here. Brick 3 does not resume until this passes.

### Step B — land the rest of Brick 3 as one coherent unit
- `consolidation_translate_member` (SECURITY INVOKER): closing rate for assets and
  liabilities, period average for income and expenses, historical/transaction-date
  rate for equity, CTA as the balancing residual.
- Revise `resolve_consolidation_scope`: currency difference becomes
  `requires_translation` instead of a dead end; add `cta_account_not_configured`
  and `insufficient_rate_coverage` blockers.
- Keep `get_consolidated_trial_balance` (untranslated) refusing mixed-currency groups;
  add `get_consolidated_trial_balance_translated` and
  `consolidation_cta_reconciliation` (opening + movement = closing).
- EXECUTE grants to `authenticated` only; never `anon`.

### Step C — configuration and reporting surfaces
- Group settings UI gains CTA equity account selection (restricted to postable,
  active equity accounts of the parent company) and translation basis.
- Consolidated trial balance gains presentation-currency columns, per-member
  translated figures, the rate used per rate class, and the CTA line.
- Zero FX arithmetic in TypeScript: the browser renders what the database computed.

### Step D — translated-path tests
Same-currency group (translation is a no-op), parent KES / subsidiary USD,
rate-coverage gap refusal, CTA reconciliation, closed-period behaviour.

Explicitly out of scope until Brick 3 closes: intercompany identification,
eliminations, consolidated cash flow, persisted consolidation runs, minority interest
measurement beyond the existing disclosure.

## Technical notes
- All new SQL is SECURITY INVOKER except where a definer function already exists and
  is documented; RLS on `journal_entry_lines` remains the access boundary, so a caller
  who cannot see a member's books cannot consolidate them.
- FX additions go inside the existing rate store (`fx_rate_on`,
  `fx_period_average_rate` already follow this) — no second resolver.
- The USD fixture needs exchange-rate coverage for every day of the tested period, or
  `fx_period_average_rate` correctly returns NULL and translation must refuse.



==============DEVELOPMENT PROGESS STATUS===================
Stopping here — the database side of Brick 3 is complete and verified; the UI wiring is not.

Done and validated this session

Corrected a real sign defect in get_consolidated_trial_balance: it applied the debit-normal closing formula (opening + dr − cr) to every account, so liabilities, equity and income closed with the wrong sign. Both consolidation functions now follow the shared accounting kernel (debit-normal = asset, expense).
Confirmed by probe that get_ledger_opening_balances returns expense openings credit-signed (a 500 debit posted earlier in the same FY comes back as -500), contradicting the kernel's debit-normal treatment. Consolidation now normalizes that sign internally.
consolidation_translate_member computes the CTA as the debit-equivalent residual in a single pass, and get_consolidated_trial_balance_translated / consolidation_cta_reconciliation build on it.
Fixture suites all pass (rolled back): mixed-currency KES/USD with a prior-period expense — cash 77,000, expense 50,000, capital 100,000, revenue 22,000, CTA 5,000 credit, translated member and group both summing to exactly zero; same-currency member produces no CTA; missing CTA account, missing rate coverage, and untranslated mixed-currency requests are all refused rather than approximated.
Remaining

Report the wider defect, don't silently absorb it. The expense-opening sign flaw is not confined to consolidation — useFinancialReport.ts and ReportCalculationEngine.ts feed the same credit-signed opening into calculateBalance with opening + dr − cr, so any expense account with earlier same-FY activity is understated by twice that amount on the single-entity P&L too. That needs its own fix and its own test, decided deliberately rather than folded into consolidation.
UI (Step C): useConsolidatedTrialBalance.ts still calls only the untranslated RPC and its CONSOLIDATION_BLOCKER_LABELS still tells users FX translation "is not built yet"; it needs the requires_translation flag, the translated hook, and the new cta_account_not_configured / insufficient_rate_coverage blockers. ConsolidatedTrialBalance.tsx needs rate-class and CTA columns plus a corrected limits notice, and ConsolidationGroupsSettings.tsx needs the CTA account picker.
Repo hygiene: the two migrations written today are in the repo, but the earlier Brick 3 drift (fx_rate_on, fx_period_average_rate, cta_account_id) was reissued rather than reconciled against its original untracked source — worth a confirming diff of DB vs. migrations before Brick 4.