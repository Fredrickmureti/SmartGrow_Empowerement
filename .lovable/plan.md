# Consolidation — Brick 7 completion (eliminations user surface)

## Verified current state (checked this session, not taken from the log)

Checked directly against the `AccrualFlowCorporation` database and the repo:

- **Elimination backend exists.** `consolidation_elimination_rules`,
  `consolidation_eliminations`, and the functions
  `consolidation_generate_eliminations`,
  `get_consolidated_statement_lines_eliminated`,
  `get_consolidated_statement_totals_eliminated` are all present. All three
  engine functions are SECURITY INVOKER, so the caller's row-level access still
  decides which companies they can consolidate; only the guard and change-log
  triggers are definer, which is correct.
- **The read/command layer exists and is honest.** `useConsolidationEliminations.ts`
  contains no arithmetic: elimination rows, per-class rules, intercompany-flow
  drill-down, the two three-column statement RPCs, plus `generate` and
  `saveRule`. It never inserts into the engine-output table.
- **There is no user-facing surface.** No eliminations page, no route in the
  finance route table, no entry in the report registry, reports nav, app
  registry or sidebar, and no architecture test for eliminations. The four
  existing consolidation pages show pre-elimination figures only.
- **The behaviour proof is claimed green but unre-run.** The behaviour block in
  `supabase/tests/consolidation_eliminations_test.sql` will be re-executed as
  the first step so the arithmetic is proven in this session, not inherited.

Verdict: Brick 7's engine is real; Brick 7 is incomplete because nobody can see
or drive it. This plan finishes Brick 7 and stops there.

## Scope of this brick

### 1. Re-prove the engine
Re-run the behaviour segments of `consolidation_eliminations_test.sql` (they
roll themselves back). Required demonstrations: a reciprocal pair eliminated to
zero on both the balance and trading legs; a cross-currency pair eliminated at
the group rate class, never at a coalesced rate of 1; an asymmetric pair
refused by default and posted to the named difference account under an explicit
policy; regeneration producing an identical set rather than duplicates;
hand-written eliminations refused; a caller who cannot reach every member
refused. If the engine is wrong the engine is fixed; if the fixture is wrong
the fixture is fixed, and the log records which.

### 2. Eliminations report page
A new `ConsolidationEliminations` report under Finance reports, built in the
same shape as `ConsolidationIntercompany` (group and period pickers, report
layout shell, permission gate, empty/loading/error states):

- every elimination leg with its class, both companies, both source accounts,
  the group account, presentation-currency debit and credit, the rate class and
  rate used, and a difference flag;
- drill-down from a leg to the intercompany positions the engine consumed;
- a **Generate** action calling the engine server-side, surfacing its refusals
  verbatim — uncovered rate, out-of-scope member, unmapped account, reciprocal
  disagreement — never a silent partial result;
- an explicit "not generated for this period yet" state, distinct from
  "nothing to eliminate".

### 3. Rule configuration
Per group and elimination class: active, tolerance, difference policy and
difference account, placed with the other consolidation configuration in
settings (`ConsolidationGroupsSettings` / `ConsolidationAccountMapping`
neighbourhood), not in the report.

### 4. Three-column consolidated statements
`ConsolidatedStatements` gains aggregated / eliminations / consolidated columns
driven by the `_eliminated` RPCs. Existing single-column figures keep their
current meaning and the pre-elimination column stays visible. Balance verdict
comes from the server's `is_balanced`, not from a client sum.

### 5. Registration and guard test
Route in `src/apps/finance/routes.tsx`, entry in `ReportRegistry.ts`,
`reportsNav.ts`, `src/lib/apps/registry.ts` and `AppSidebar.tsx`, gated on the
same permission as its siblings. An architecture test in
`src/test/architecture/` asserting no elimination arithmetic lives in
TypeScript, matching the existing consolidation architecture tests.

### 6. Checkpoint
Write the Brick 7 section of `.lovable/consolidation-brick-log.md`: what was
established, what changed, what was verified by execution, the accounting rules
now enforced, the security boundary, and what is intentionally absent
(unrealised profit in inventory, intercompany fixed-asset transfers, investment
versus equity elimination, NCI allocation). Backfill the missing sections for
bricks 1, 2, 3 and 5 from executed evidence only.

## Explicitly out of scope here

Brick 8 (persisted, versioned consolidation runs and audit trail), Brick 9
(ownership / non-controlling interest), Brick 10 (consolidated cash flow). No
placeholders for them are created.

## Technical notes

- No new migrations are expected; the Brick 7 schema is complete. If the
  behaviour proof exposes an engine defect, the fix goes in a migration.
- No second FX resolver: rates keep coming from
  `consolidation_member_translation_rates` / `fx_rate_on`.
- No second accounting engine: eliminations consume the intercompany and
  translation functions, which consume the authoritative finance primitives.
- The front end reads engine output and writes only policy rows.



=================IMPLEMENTATION PROGRESS AND STATUS LOG=============
Brick 7 is now closed: the eliminations surface is proven green (behaviour suite BRICK7 BEHAVIOUR OK, 17 architecture tests passing) and the brick log has its Brick 7 checkpoint plus the backfilled Bricks 1, 2, 3 and 5 sections written from executed evidence only. Next up would be Brick 8 (persisted, versioned consolidation runs) whenever you want it.



because I attempred to genearte eliminations 

Before starting brick 8 I want you run a test on intercompany eliminations like simulate real event  because I attempted to do to and an error message was printed on the screen (The elimination run was refused

The elimination run was refused) and a toast of (The elimination run was refused
) ) and this console log was logged in the browser --> (@supabase_supabase-js.js?v=818a1ce2:19821  POST https://jkszmrroyjfdwokbkzis.supabase.co/rest/v1/rpc/consolidation_generate_eliminations 400 (Bad Request))

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