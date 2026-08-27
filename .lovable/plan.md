# Consolidation — independent verification (2026-08-27, 11:5x UTC) and Brick 7

## What I verified myself, directly, this session

Against the live `AccrualFlowCorporation` database and the repo — not taken from
the previous engineer's notes:

- **Six consolidation tables exist and are secured.** `consolidation_groups`,
  `_group_members`, `_group_accounts`, `_account_mappings`,
  `_intercompany_partners`, `_group_change_log` all have row-level security
  enabled with policies attached (2 each; the append-only change log has 1).
- **The engine exists and is substantial.** Present as real database functions:
  scope resolution, member translation rates, member translation, translated and
  untranslated consolidated trial balance, statement lines, statement totals,
  CTA reconciliation, intercompany balances / activity / coverage, unmapped
  accounts, plus the guard and change-log triggers for every table.
- **Return contracts are genuine, not cosmetic.** The trial balance carries
  member, account, ownership and per-account balances; statements carry
  section/derived/residual structure and a presentation currency; intercompany
  balances carry both sides, both closing rates and the reciprocal difference.
  These are drill-down-capable shapes, not flat totals.
- **No elimination or consolidation-run objects exist anywhere** — no tables, no
  functions. Brick 7 and Brick 8 are genuinely unstarted.
- **Front end is real and routed.** `ConsolidatedTrialBalance`,
  `ConsolidatedStatements`, `ConsolidationIntercompany` and the legacy
  `Consolidation` comparative page all exist under Finance reports and are
  registered in the report registry and reports nav.
- **Seven SQL suites are committed** under `supabase/tests/` covering bricks 1–6,
  and they assert architecture, not just output — e.g. the intercompany suite
  fails the build if the function is `SECURITY DEFINER`, if it stops reading the
  AR/AP sub-ledger views, if it bypasses the group rate resolver or the scope
  gate, or if any rate is coalesced to 1.

Conclusion: the previous engineer's Phase 0 claim holds up structurally. The one
thing I cannot confirm from static inspection is the *execution* result of each
suite in this session, so Phase 0 re-runs them before any new code lands.

## Still genuinely outstanding

1. Brick 7 — elimination engine. Nothing exists.
2. Brick 8 — persisted, versioned consolidation runs. Nothing exists.
3. Brick 9 — ownership / non-controlling interest. Members carry an ownership
   basis, but there is no NCI presentation, which IFRS 10 requires.
4. Brick log sections for bricks 1, 2, 3 and 5 are still missing.

## Order of work

```text
Phase 0   Re-execute the six brick suites, confirm green, backfill the brick log
Brick 7   Elimination engine
Brick 8   Consolidation runs, versioning, audit trail
Brick 9   Ownership / NCI presentation
Brick 10  Consolidated cash flow (only if the primitives support it)
```

## Phase 0 — prove the base before building on it

Execute each committed suite against the live database, one at a time, recording
pass/fail per block. Every suite rolls back; residue is checked after each run.
Anything that fails is fixed in the engine when the engine is wrong, or in the
fixture when the fixture is wrong, and the log says which. Then backfill the
brick-log sections for bricks 1, 2, 3 and 5 from executed evidence only.

## Brick 7 — elimination engine (this brick's exact scope)

**Principle.** An elimination is a persisted, group-scoped, period-scoped,
deterministic adjustment derived from *declared* intercompany relationships and
the authoritative ledger — never inferred from account names or descriptions,
never subtracted in the browser.

In scope for Brick 7:

- Reciprocal intercompany receivable/payable positions (due-to / due-from).
- Intercompany revenue and matching cost recharges.

Explicitly **out** of scope for this brick, and left absent rather than stubbed:
unrealised profit in inventory, intercompany fixed-asset transfers, investment-
in-subsidiary versus equity elimination, and NCI allocation. Those belong to
later bricks and the schema will be shaped so they can be added without rework.

What gets built:

- **Elimination rule configuration** — per group: which elimination classes are
  active, which group accounts absorb the debit/credit, tolerance for reciprocal
  differences, and what happens when the two sides disagree beyond tolerance
  (refuse, or post the residual to a named difference account — configured, never
  silently chosen).
- **Elimination entries** — generated server-side, balanced by construction,
  each carrying: group, period, elimination class, both member businesses, both
  source accounts, group account, presentation-currency amount, the rate class
  and rate used, and the source evidence that produced it.
- **Deterministic generation function** — given group and period, produces the
  same set every time; reads only `consolidation_intercompany_balances` /
  `_activity` and the scope resolver; refuses on uncovered FX, out-of-scope
  members, unmapped accounts, and inverted date ranges, exactly as the existing
  engine refuses.
- **Reporting integration** — the consolidated trial balance and statements gain
  an *eliminations* column alongside the aggregated column, so a reader always
  sees pre-elimination, elimination and post-elimination side by side. The
  existing figures do not change meaning; nothing is quietly rewritten.
- **UI** — an eliminations view under Finance reports listing every elimination
  entry with its source pair, class, amounts and drill-down to the underlying
  positions, plus the group-level rule configuration in the consolidation
  configuration area.
- **Security** — same posture as the rest of the subsystem: organization-scoped
  RLS, `authenticated` and `service_role` grants only, no anon reads, and the
  generation function gated on the scope resolver so a user who cannot access
  every member cannot generate or read the group's eliminations.
- **Tests** — a committed SQL suite in the same style: reciprocal pair
  eliminated to zero, asymmetric pair handled per the configured policy,
  cross-currency pair eliminated at the correct rate class, out-of-scope member
  refused, cross-organization isolation, regeneration idempotent, and an
  architecture assertion that no elimination arithmetic lives in TypeScript.

**Exit condition.** For a group with declared intercompany relationships, the
consolidated statements show revenue and receivables net of intercompany
activity, every eliminated figure traces to its source pair and rate, and
regenerating the period produces an identical set.

## Technical notes

- New tables follow the established pattern: create, GRANT to `authenticated`
  and `service_role`, enable RLS, organization-scoped policies, guard trigger,
  change-log trigger reading the row from its `jsonb` image.
- No second FX resolver: rates continue to come from
  `consolidation_member_translation_rates` and `fx_rate_on`.
- No second accounting engine: eliminations consume the existing intercompany
  and translation functions, which in turn consume the authoritative finance
  primitives.
- Shared finance primitives are not modified in this brick.
- Test data may be seeded where the tenant does not supply a scenario; all suite
  fixtures roll back.

## Checkpoint

Brick 7 ends with a written record of what was established, what changed, what
was verified by execution, the accounting rules now enforced, the security
boundary, and what remains intentionally unimplemented. Brick 8 does not start
until that record exists.



===============DEVELOPMENT PROGRESS STATUS====================


Brick 7's foundations are in the database and verified as far as the contract layer goes. Here's where things stand.

Landed and applied

consolidation_elimination_rules — one rule per group and elimination kind (active flag, tolerance, difference policy, difference group account), RLS-scoped to org members who can reach the group's parent, writable only by owner/admin/super_admin, with a guard trigger enforcing that a "post the difference" rule names a valid group account of the same group.
consolidation_eliminations — the generated set (group, period, class, both companies, group account, debit/credit, evidence). Read-only to users; a trigger makes hand-posting impossible, so every figure is reproducible from the ledgers. Anon privileges revoked on both tables.
consolidation_intercompany_flows — SECURITY INVOKER, gated on resolve_consolidation_scope, translated through get_consolidated_trial_balance_translated (no second rate book). Attributes every leg of a tagged intercompany entry to that counterparty; balance-sheet accounts cumulative, P&L accounts period-only; refuses entries tagged to two sister companies and flows on accounts the consolidated TB doesn't report.
consolidation_generate_eliminations — per company pair and class, reverses both sides in full so the entry always balances; a reciprocal disagreement either refuses the run or posts to the configured difference account per rule. Regeneration replaces the prior set for that group/period/class.
get_consolidated_statement_lines_eliminated / ..._totals_eliminated — three columns: aggregated, eliminations, consolidated. Existing statement functions untouched.
supabase/tests/consolidation_eliminations_test.sql written (contract + behaviour blocks, self-rolling-back).
Verified

Contract block passes end to end against the live database (BRICK7 CONTRACT OK): all four functions exist and are SECURITY INVOKER, the engine reuses the TB/scope machinery, anon holds nothing, hand-posting is trigger-protected.
Not yet verified / remaining

The behaviour block has not passed yet. Its first run failed inside consolidation_intercompany_flows (CREATE TABLE is not allowed in a non-volatile function); I removed the scratch tables and reissued the function, but the behaviour block needs re-running to confirm the numbers (4 legs, 10,000 each side, revenue and the intercompany payable eliminated to zero, balanced balance sheet, idempotent regeneration, the 400 difference case, and the authorisation refusal). Treat Brick 7's arithmetic as unproven until that block returns BRICK7 BEHAVIOUR OK.
No frontend yet: the eliminations page (generate, drill-down, rule configuration) and the three-column view on the consolidated statements page are still to build.
Brick 8 (persisted, versioned consolidation runs) and NCI presentation remain unstarted.
Next step when you resume: re-run the behaviour block from supabase/tests/consolidation_eliminations_test.sql, then build the UI.
==============================================
# Execution Instructions

1. **Verify Previous Implementation**

   * Before making any new changes, carefully verify that the previous implementation has been fully completed, correctly integrated, and actually landed in the codebase and database where applicable.
   * Do not assume that a previous task was completed merely because the relevant code appears to exist. Validate the actual behavior, dependencies, and business flow.

2. **Proceed Chronologically**

   * Once the previous step has been verified, identify the **next logical step, brick, or item in the sequence**.
   * Follow the established implementation order rather than jumping ahead or working on unrelated areas.

3. **Work Professionally and Analytically**

   * Approach each step systematically and from first principles.
   * Understand the existing architecture, business logic, dependencies, and intended behavior before making changes.
   * Avoid rushed, speculative, or superficial implementations.

4. **Maintain Stability**

   * Preserve existing functionality and architectural integrity while progressing to the next step.
   * Ensure each completed brick leaves the system in a stable, coherent state before proceeding further.

5. **Keep the Process Organized**

   * Clearly establish what has already been completed, what remains, and what the current step is intended to accomplish.
   * Work through the sequence incrementally and methodically rather than attempting to implement everything at once.



KINDLY NOTE , YOU ARE ALLOWED TO SEED TEST DATA WHERE ITS NEEDED AND WHEN THE TEST TENANT DOES NOT PROVIDE IT