# Consolidation — verification verdict (2026-08-27, 13:0x UTC) and closing Brick 7

## What I verified myself this session

Directly against the live `AccrualFlowCorporation` database and the repo, not
taken from the previous engineer's notes:

- **Bricks 1–6 objects are present.** Scope resolution, member translation rates,
  member translation, translated/untranslated consolidated trial balance,
  statement lines and totals, CTA reconciliation, intercompany balances /
  activity / coverage, unmapped accounts, plus guard and change-log triggers for
  every consolidation table.
- **Brick 7 backend landed as claimed.** `consolidation_elimination_rules`,
  `consolidation_eliminations`, `consolidation_intercompany_flows`,
  `consolidation_generate_eliminations`,
  `get_consolidated_statement_lines_eliminated` and
  `..._totals_eliminated` all exist. Every engine function is SECURITY INVOKER
  (only the guard/log triggers are definer, which is correct), so scope RLS
  still applies to the caller.
- **No elimination front end exists.** Nothing in `src/` references the
  elimination tables or the `_eliminated` statement functions; the only match is
  the generated Supabase types file. The four consolidation pages
  (`Consolidation`, `ConsolidatedTrialBalance`, `ConsolidatedStatements`,
  `ConsolidationIntercompany`) do not show eliminations.
- **The Brick 7 suite exists but its behaviour half is unproven.**
  `supabase/tests/consolidation_eliminations_test.sql` has a contract block and a
  behaviour block; the previous engineer got the contract block green and
  explicitly recorded that the behaviour block never passed after the
  `CREATE TABLE in a non-volatile function` failure was patched.

Verdict: Brick 7 is **not complete**. Its arithmetic is unproven and it has no
user-facing surface. Brick 8 does not start until both are fixed.

## Still genuinely outstanding

1. Brick 7 behaviour proof (elimination arithmetic unverified by execution).
2. Brick 7 UI: eliminations report + rule configuration + three-column
   (aggregated / eliminations / consolidated) statements.
3. Brick 8 — persisted, versioned consolidation runs and audit trail.
4. Brick 9 — ownership / non-controlling interest presentation (IFRS 10).
5. Brick log sections for bricks 1, 2, 3, 5 and 7.

## Order of work

```text
Phase 7a  Prove the elimination engine by execution
Phase 7b  Elimination UI + three-column statements
Phase 7c  Brick 7 checkpoint record
Brick 8   Consolidation runs, versioning, audit trail
Brick 9   Ownership / NCI presentation
Brick 10  Consolidated cash flow (only if the primitives support it)
```

## Phase 7a — prove the engine

Run the behaviour block against the live database and drive it to green. It must
demonstrate, from seeded fixtures that roll back:

- a reciprocal intercompany pair eliminated to zero on both revenue and the
  intercompany payable/receivable, with the entry balanced by construction;
- a cross-currency pair eliminated at the group rate class, never at a coalesced
  rate of 1;
- an asymmetric pair handled exactly per the group's configured difference
  policy — refuse, or post the residual to the named difference account;
- regeneration for the same group/period/class producing an identical set (no
  duplication);
- a caller who cannot reach every member refused;
- cross-organization isolation.

Where the engine is wrong the engine is fixed; where the fixture is wrong the
fixture is fixed, and the log records which. Nothing else lands until the block
returns `BRICK7 BEHAVIOUR OK`.

## Phase 7b — the user-facing surface

- **Eliminations report** under Finance reports: for a chosen group and period,
  every elimination entry with its class, both companies, both source accounts,
  the group account, presentation-currency amounts, and the rate class/rate used;
  drill-down to the underlying intercompany positions that produced it.
- **Generate action** calling `consolidation_generate_eliminations` server-side,
  surfacing the engine's refusals (uncovered FX, out-of-scope member, unmapped
  account, reciprocal disagreement) as explicit, readable errors — never a silent
  partial result.
- **Rule configuration** in the consolidation configuration area: per group and
  elimination kind — active, tolerance, difference policy, difference account.
- **Three-column consolidated statements**: `ConsolidatedStatements` gains
  aggregated / eliminations / consolidated columns off the `_eliminated`
  functions. The existing single-column figures keep their meaning; the
  pre-elimination column stays visible.
- Registered in the report registry and reports nav like the sibling pages, and
  permission-gated the same way.
- Architecture test in the existing `src/test/architecture/` style asserting no
  elimination arithmetic lives in TypeScript.

## Phase 7c — checkpoint

Write the Brick 7 section of `.lovable/consolidation-brick-log.md`: what was
established, what changed, what was verified **by execution**, the accounting
rules now enforced, the security boundary, and what is intentionally absent
(unrealised profit in inventory, intercompany fixed-asset transfers, investment
versus equity elimination, NCI allocation). Backfill the missing sections for
bricks 1, 2, 3 and 5 from executed evidence only.

## Technical notes

- No second FX resolver: rates keep coming from
  `consolidation_member_translation_rates` / `fx_rate_on`.
- No second accounting engine: eliminations consume the intercompany and
  translation functions, which consume the authoritative finance primitives.
- Any new table follows the established pattern: create, GRANT to
  `authenticated` and `service_role` only, enable RLS, organization-scoped
  policies, guard trigger, change-log trigger.
- Shared finance primitives are not modified in this brick.
- Front end reads engine output; it never computes eliminations.
