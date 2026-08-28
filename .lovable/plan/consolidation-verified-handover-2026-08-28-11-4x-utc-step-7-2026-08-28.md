# Consolidation — verified handover (2026-08-28, 11:4x UTC), Step 7.7 then Brick 8

Your Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected — no connection work is needed.

## Phase 1 — what I verified this session (not taken on trust)

Checked directly against the live database and the repository:

**Genuinely landed**
- The engine is server-side and SECURITY INVOKER throughout: `resolve_consolidation_scope`, `consolidation_translate_member`, `get_consolidated_trial_balance(_translated)`, `get_consolidated_statement_lines/_totals` and their `_eliminated` variants, `consolidation_intercompany_balances/activity/coverage/flows/entry_lines`, `consolidation_generate_eliminations`, `consolidation_diagnose_eliminations`, `consolidation_elimination_evidence`, `consolidation_eliminations_balance`, `consolidation_reverse_eliminations`, `consolidation_cta_reconciliation`. Only the trigger guards and the scope-count helper are DEFINER.
- Tables present: groups, members, group accounts, account mappings, intercompany partners, elimination rules, eliminations, group change log, and `consolidation_elimination_events`.
- **Step 7.5 (audit trail) is real**, contrary to the brick log, which still lists it as absent. `consolidation_elimination_events` exists and the eliminations report renders a "History of this period's runs" panel from it.
- **Step 7.6 (period control and reversal) is real.** `consolidation_generate_eliminations` refuses when a member's fiscal period covering the range is closed, with a remedy-carrying message; `consolidation_reverse_eliminations` exists and the page has a reason-required withdrawal dialog.
- The traceability wave closed: five surfaces on one drill primitive, one branded export pipeline, `docs/consolidation-traceability-lineage.md` written.
- `npx tsgo --noEmit -p tsconfig.app.json` is clean.

**Confirmed still open**
1. **Step 7.7 — the realistic scenario proof does not exist.** `supabase/tests/` has ten consolidation suites, none of which is the multi-scenario proof the parent prompt requires (independent companies, differing charts, KES parent / USD subsidiary, intercompany sale, reciprocal AR/AP, CTA, closed-period refusal, double-run idempotence, cross-organization isolation).
2. **The brick log is stale.** It ends at Step 7.4 and explicitly names audit history, period control and reversal as "intentionally absent" — both now false. A closure record that misstates what exists is worse than none.
3. **Brick 8 has not been started.** There is no persisted, versioned consolidation run: figures are recomputed on every read, so "what did we report for 2026-08, and on what basis?" cannot be answered.

## Phase 2 — plan corrections carried forward

- Brick 8 stays strictly persistence and versioning of what the engine already computes. No NCI, no equity method, no consolidated cash flow, and no placeholders for them.
- One accounting truth: a run stores the output of the existing RPCs. It never recomputes balances, never resolves its own FX rates, and the browser never does arithmetic.
- A step closes only when its SQL suite has executed against the live database and the result is recorded in the brick log.
- Status claims are re-derived from the repository and database at the start of each session, never copied forward from a previous log.

## Work order

### Step 7.7 — Realistic scenario proof (do first; blocks Brick 8)

New `supabase/tests/consolidation_scenarios_test.sql`, built as separate blocks in one rolling-back transaction, each block a fixture in a dedicated test organization — nothing seeded into the live tenant:

1. Two independent companies, no intercompany — group totals equal the sum of translated members.
2. Different charts of accounts mapped to one group chart — an unmapped account refuses rather than silently dropping.
3. Parent KES / subsidiary USD — closing rate on balance items, average rate on income items, residual to the translation reserve, CTA reconciliation ties.
4. Intercompany sale A→B — revenue and COGS eliminate to nil at group level.
5. Reciprocal AR/AP — the pair eliminates and the set balances (`consolidation_eliminations_balance` = balanced).
6. Closed member period — generation refuses with the remedy message.
7. Double run — regenerating produces the same legs and one additional audit event, never duplicated accounting effect.
8. Reversal — withdrawal clears the set, records the event, and leaves the statement unchanged from pre-generation.
9. Cross-organization isolation — a caller from another organization receives nothing from any consolidation RPC.

Run one file at a time, never batched.

### Step 7.8 — Correct the brick log

Rewrite the stale "intentionally absent" claims and add the Step 7.5, 7.6 and 7.7 sections in the log's existing format: what was verified by execution, what changed, the accounting rule now enforced, the security boundary, what remains deliberately absent.

### Brick 8 — Persisted, versioned consolidation runs

Only after 7.7 passes.

- `consolidation_runs`: group, period from/to, presentation currency, state (draft / final / superseded), FX basis snapshot, rule-set snapshot reference, actor, timestamps, and the balance verdict. Grants to `authenticated` and `service_role` only, RLS by organization and group access, append-only state transitions through a function.
- `consolidation_run_lines`: the frozen statement lines the run produced, each traceable to group account, member contributions and the elimination legs that moved it.
- `consolidation_create_run` / `consolidation_finalize_run` / `consolidation_supersede_run`: SECURITY INVOKER, period-controlled the same way generation is, refusing an unbalanced elimination set and any period a member has closed.
- Surface: a run history and run viewer on the consolidated statements report, where a finalized run is read from storage rather than recomputed, and a live view is clearly labelled as live.
- Its own SQL suite plus architecture-test coverage, then a brick log section.

## Explicitly out of scope

Non-controlling interest, equity method, consolidated cash flow, and any TODO scaffolding for them.

## Technical notes

- Each new database object goes in its own small migration; grants to `authenticated` and `service_role` only.
- All arithmetic stays in SQL; architecture tests in `src/test/architecture/` are extended in the same change as any new surface.
- Verification is `npx tsgo --noEmit -p tsconfig.app.json` (the solution-style `tsconfig.json` checks nothing) plus the consolidation suites.
- This is an external Supabase project, so the sandbox cannot mint a signed-in session; anything that genuinely needs a logged-in click is reported as such rather than claimed green.
