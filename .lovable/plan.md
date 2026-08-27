# Consolidation — verified handover (2026-08-27, 10:0x UTC) and closing Brick 6

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected. No connection work is needed.

Every statement in the "current state" section below was re-checked this session against the live database and the repository. The previous engineer's notes were treated as unverified until confirmed.

## Phase 1 — verified current state

### Confirmed genuinely present

- **Bricks 1–5 engine exists in the live database.** All consolidation functions are present, all are INVOKER-rights (`prosecdef = false`) except the trigger guards, and every callable one is granted to `authenticated` and `service_role` only — no `anon`, no `public`. Confirmed: `resolve_consolidation_scope`, `consolidation_translate_member`, `consolidation_member_translation_rates`, `get_consolidated_trial_balance`, `get_consolidated_trial_balance_translated`, `get_consolidated_statement_lines`, `get_consolidated_statement_totals`, `consolidation_cta_reconciliation`, `consolidation_unmapped_accounts`, `consolidation_group_uses_group_chart`, `consolidation_scope_member_count`, `close_consolidation_member`, plus the eleven `_consolidation_*` guard and audit triggers.
- **Brick 6 database surface landed.** `consolidation_intercompany_balances`, `consolidation_intercompany_activity` and `consolidation_intercompany_coverage` all exist with the same rights and grant profile.
- **Brick 6 application surface landed.** `useConsolidationIntercompany.ts` exposes all three RPCs through a shared `callConsolidationRpc` helper, and `ConsolidationIntercompany.tsx` renders declarations, reconciliation and the coverage worklist.
- **Step 4a is in fact done, contrary to the previous plan's own Phase 1 note.** The plan text says "Step 4 has not been started" and that the suite is "still the original 243-line suite". That is stale. `supabase/tests/consolidation_intercompany_test.sql` is 619 lines and carries a third block covering the group-account projection, GL-only intercompany activity, the unmapped refusal, the coverage worklist and cross-organization isolation — a two-member, two-currency, two-chart fixture that rolls itself back.

### Confirmed still open

- **The architecture ratchet was not extended.** `src/test/architecture/consolidation-intercompany.test.ts` mentions only `consolidation_intercompany_partners` and `consolidation_intercompany_balances`. It contains no reference to the activity RPC, the coverage RPC, or the group-account columns. Everything Brick 6 added last session is unguarded against regression.
- **Only Block 3 has been executed.** Blocks 1 and 2 of the intercompany suite, and the Brick 1–5 suites, have not been re-run since the Brick 6 changes.
- **The brick log is incomplete.** `.lovable/consolidation-brick-log.md` contains a Brick 4 section and nothing else — no Brick 6 section, and also no Brick 1, 2, 3 or 5 sections. It is not the closure record the process assumes.
- **Consolidation has still never run against more than one member in live data.** The live tenant holds 1 group, 1 member, 0 group accounts, 0 mappings, 0 intercompany declarations. Every multi-entity proof exists only inside rolling-back test transactions.

So Brick 6 is code-complete and partially proven. It is not closeable, and Brick 7 (eliminations) must not start.

## Phase 2 — plan corrections carried forward

- Brick 6 stays identification only: no elimination arithmetic, no persisted runs, no minority interest, no placeholders, no disabled controls.
- One accounting truth: intercompany figures stay a projection of `get_consolidated_trial_balance_translated`. No second rate resolver, no browser arithmetic.
- A brick closes only when its SQL suite has been executed against the live database and the result recorded in the brick log.
- **Added this session:** the brick log must be backfilled for Bricks 1, 2, 3 and 5, not only Brick 6. A closure record that skips four bricks cannot answer "where did this consolidated number come from?".
- **Added this session:** the stale-status failure mode itself needs fixing. The plan file asserted the suite was untouched when it had grown by 376 lines. Status claims must be re-derived from the repository at the start of each session, never copied forward.

## Work order — Brick 6 closure

### Step A — extend the architecture ratchet

Extend `src/test/architecture/consolidation-intercompany.test.ts` so it holds:

- the activity and coverage RPCs stay reachable from the hook and the page, and both appear in the generated database types;
- the client never derives intercompany pairs, account mappings or translated amounts itself;
- the group-account columns stay on the reconciliation table;
- refusals from either RPC stay rendered as an explanation, never as an empty table or a zero.

### Step B — execute the suites and record the result

Run the intercompany suite's Blocks 1 and 2 as a regression pass, then the Brick 1–5 suites: `consolidation_group_foundation_test.sql`, `consolidation_translation_test.sql`, `consolidated_trial_balance_test.sql`, `consolidated_trial_balance_reconciliation_test.sql`, `consolidation_account_mapping_test.sql`, `consolidated_statements_test.sql`. Record pass/fail per block.

These run one file at a time, never batched — the suites are large and running them together has previously overwhelmed the database.

### Step C — live multi-member walkthrough

Drive a genuine two-member group (different base currencies, different charts) through group settings, consolidated trial balance, consolidated statements and the intercompany page in the running app. Record what was observed, including one deliberate unmapped-account refusal. Fixture data is created and removed within the walkthrough; nothing is left seeded in the live tenant.

### Step D — write the brick log

Write the Brick 6 section, and backfill Bricks 1, 2, 3 and 5, each recording: what was established, what changed, what was verified, the accounting rules and security boundaries that now exist, which suites ran, and what is deliberately still absent.

## Explicitly out of scope until Brick 6 closes

Elimination arithmetic, persisted consolidation runs, consolidated cash flow, equity method, minority interest. No TODO scaffolding for any of them.

## Technical notes

- Any new database object goes in its own small migration; grants to `authenticated` and `service_role` only.
- Test data is created and rolled back inside each suite; nothing is seeded into the live tenant.
- Contact-to-business scoping uses `contacts.business_id` / `contacts.organization_id`; `commercial_partner_id` and `parent_contact_id` stay contact-hierarchy concerns.

The seed didn't land — the whole block is one transaction and it aborted, so your database is exactly as it was before I started. Nothing partial was written.

The stop is actually the engine being right, and it's worth recording: _consolidation_mapping_guard refuses to let the group's translation reserve (parent account 3050) be mapped to a group account. The CTA is computed by the translation engine and presented on its own line; mapping it would let a manually-posted reserve balance flow in alongside the computed one and double-count the translation adjustment. My seed tried to map it out of habit — the guard blocked it. That's a genuine invariant, not an obstacle.

What remains, in order:

Drop the 3050 → G-3900 mapping row and the G-3900 group account from the seed entirely — the CTA line comes from the engine, so the group chart shouldn't carry a slot for it. Everything else in the block is unchanged and was already accepted by the guards up to that point (companies, rate series, accounts, contacts, members, group chart, the first five mappings).
Re-run the corrected block.
Verify the seed by query: closing rate at 2026-07-31 should be 128.19 and the historical rate at 2026-05-15 121.26, so translation is genuinely exercised and a real CTA falls out rather than a zero.
Run the multi-member walkthrough in the browser against Joshua Holdings Group for June–July 2026 — the trial balance, the intercompany pair report (the USD recharge is deliberately asymmetric: KES 600,000 on the parent against USD 4,500 on the subsidiary, so a real difference surfaces instead of a tidy zero), and the coverage worklist, which should suggest Mombasa Port Services as undeclared.
Add a ratchet guard asserting the CTA account cannot be mapped, so this invariant is protected by test and not just by trigger.
Update the brick log with the walkthrough result.
Two disclosures about the seed as designed: it points the group's CTA at your existing 3050 reserve rather than inventing an account, and it changes the parent's own membership from proportional to full — at 100% ownership those produce identical numbers, but full is the correct method for a parent and proportional would have been misleading in the UI. Say the word if you'd rather I leave that membership alone.

KINDLY NOTEM WHEN RUNNING TEST MIGRATIONS, RUN THEM carefully and professionally so that you dont ovewhelm the database because there are some big test migartions that when run all at once makes supabase shut down 


YOU ARE ALLOWED TO SEED TEST DATA WHERE ITS ACTUALLY NEEDED AND THE TEST TENANT DONT HAVE IT
after all the test next in line is --> Next brick would be eliminations 

==========================================================
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
