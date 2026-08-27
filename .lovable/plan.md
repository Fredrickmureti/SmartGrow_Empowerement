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
