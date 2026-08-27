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

The two sides of the intercompany_balance position between Mombasa Port Services and Joshua Holdings differ by 40000.00 KES (Mombasa Port Services reports in USD, Joshua Holdings reports in KES, the group reports in KES). A gap of this kind is what currency retranslation leaves behind, not a figure the companies disagree on: set this class's difference handling to carry the difference to the translation reserve, or raise the tolerance above 40000.00 KES if you consider it immaterial)

BUT NOW INSTEAD OF JUST SHOWING THE MESSAGE , there should be a drill down link that take users to whefe they can resolve the issue not just show messages and toast , the system should be context aware and offer the remedy and quick action button to actually resolve that or take them to where the issue can be resolved and not just take them to that page, they should be taken to page and the section where they can perfom the actions is focused so they dont have to scroll alot



THIS WAS THE AGENT'S REMEDY BEFORE ITS TIME RUN OUT pertaining the issue above
====================================================

What I found while investigating: the refusal message is produced by the database and rendered as plain text in ConsolidationEliminations.tsx (the red alert plus a toast) — there's no remedy affordance. The remedy lives in ConsolidationEliminationRules (rendered inside ConsolidationGroupsSettings on /finance/settings), and that component currently has no way to be deep-linked or focused: the group is picked by local state and the class blocks have no anchors.

What remains, when you're ready to resume:

Add a small presentation-only helper (e.g. src/lib/finance/eliminationRefusal.ts) that reads a refusal message and derives a remedy: the elimination class, the gap amount and currency, and whether the cause is a currency retranslation residual.
In ConsolidationEliminations.tsx, render that remedy inside the refusal alert as concrete quick actions — "Carry the difference to the translation reserve" and "Raise the tolerance above X" — each linking to /finance/settings?consolidationGroup=<id>&eliminationClass=<class>&suggestPolicy=…&suggestTolerance=…#consolidation-elimination-policy.
In ConsolidationGroupsSettings, honour consolidationGroup from the URL so the right group is already selected on arrival.
In ConsolidationEliminationRules, give each class block an id, scroll the targeted block into view, ring-highlight it, prefill the suggested policy/tolerance into the draft, and show a short "you arrived here from a refused run" note with a one-click Save — so the fix is two clicks, no scrolling.
Re-run the generation against the live tenant afterwards to confirm the loop actually closes, and typecheck.


DO NOT TRUST IT, REAUDIT AND PROVIDE EVEN A MORE ADVANVED AND ROBUST REMEDY AND CONETXT AWARE KIND OF SYSTEM
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