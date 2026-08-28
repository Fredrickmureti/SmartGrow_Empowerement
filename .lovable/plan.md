# Consolidation — verified handover (2026-08-28, 12:2x UTC) and Brick 8

Your Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected — no connection work is needed.

## Phase 1 — what I verified this session (not taken on trust)

Checked directly against the live database and the repository, not against the previous engineer's notes:

**Genuinely landed**
- Engine functions all exist and are SECURITY INVOKER: `resolve_consolidation_scope`, `consolidation_translate_member`, `consolidation_member_translation_rates`, `get_consolidated_trial_balance(_translated)`, `get_consolidated_statement_lines/_totals` and their `_eliminated` variants, the six `consolidation_intercompany_*` readers, `consolidation_generate_eliminations`, `_diagnose_`, `_evidence`, `_balance`, `consolidation_reverse_eliminations`, `consolidation_cta_reconciliation`, `consolidation_unmapped_accounts`. The only DEFINER function in the family is `consolidation_scope_member_count`.
- Nine consolidation tables exist: groups, members, group accounts, account mappings, intercompany partners, elimination rules, eliminations, elimination events, group change log.
- **Step 7.7 is real.** `supabase/tests/consolidation_scenarios_test.sql` exists (654 lines) covering differing charts with unmapped refusal, KES/USD translation with CTA, intercompany elimination with re-run and withdrawal, closed-period refusal and cross-organization isolation.
- **Step 7.8 is real.** The brick log now carries the Step 7.7 section and an explicit correction of the stale "audit trail and period control are absent" claim.
- Five consolidation surfaces exist in the app (Consolidation, Consolidated Trial Balance, Consolidated Statements, Intercompany, Eliminations) with matching hooks and three settings surfaces.

**Confirmed still open**
- **Brick 8 has not been started.** There is no `consolidation_runs` table in the database and no run concept anywhere in the code. Every consolidated figure is recomputed on each read, so "what did we report for August 2026, and on what basis?" cannot be answered after the fact.

No incomplete or superficial work was found in Bricks 1–7 that needs reopening before Brick 8.

## Phase 2 — plan corrections carried forward

- Brick 8 stays strictly persistence and versioning of what the engine already computes. No non-controlling interest, no equity method, no consolidated cash flow, and no placeholder scaffolding for them.
- One accounting truth: a run stores the output of the existing RPCs. It never recomputes balances, never resolves its own FX rates, and the browser never does arithmetic.
- Added to the previous plan after reviewing the engine: a run must also freeze the **FX rate basis actually used** (from `consolidation_member_translation_rates`) and the **member scope as resolved**, otherwise a finalized run cannot be re-explained once rates or membership change. The earlier plan mentioned an "FX basis snapshot" without saying where it comes from.
- Added: finalizing must refuse when `consolidation_unmapped_accounts` returns rows, for the same reason generation refuses — a run built on a silently dropped account is not a group statement.

## Work order — Brick 8, persisted and versioned consolidation runs

Each numbered step is one small migration or one code change, executed and verified before the next. No batching.

### 8.1 — Run header
`consolidation_runs`: group, period from/to, presentation currency, state (`draft` / `final` / `superseded`), the balance verdict from `consolidation_eliminations_balance`, actor, timestamps. Grants to `authenticated` and `service_role` only; RLS by organization and group access mirroring `consolidation_groups`; state transitions only through functions (append-only in effect, no direct UPDATE of state).

### 8.2 — Run detail
- `consolidation_run_lines` — the frozen statement lines the run produced, each carrying its group account, the member contributions behind it and the elimination effect that moved it.
- `consolidation_run_rates` — the per-member closing/average/historical rates the run translated at.
- `consolidation_run_members` — the member scope as resolved at run time, with ownership and method.

### 8.3 — Run lifecycle functions
`consolidation_create_run`, `consolidation_finalize_run`, `consolidation_supersede_run` — SECURITY INVOKER, same period control as generation (refuse when a member's covering fiscal period is closed), refusing an unbalanced elimination set and refusing unmapped accounts, with remedy-carrying messages in the established style. Creating a run for a period that already has a `final` run supersedes it rather than duplicating; a repeated create in the same second is idempotent, not a second run.

### 8.4 — Surface
Run history and run viewer on the Consolidated Statements report. A finalized run is read from storage and labelled with its date, actor and FX basis; the unsaved view stays clearly labelled "live". Drill-down from a stored line uses the existing drill primitive against the stored contributions, not a recomputation.

### 8.5 — Proof
`supabase/tests/consolidation_runs_test.sql`: create/finalize/supersede, refusal on closed period, refusal on unbalanced eliminations, refusal on unmapped accounts, a finalized run unchanged after rates are edited, and cross-organization isolation. Plus an architecture test asserting the run surface reads only run tables. Then a brick log section in the existing format.

## Explicitly out of scope

Non-controlling interest, equity method, consolidated cash flow, and any TODO scaffolding for them.

## Technical notes

- Each new database object goes in its own small migration; grants to `authenticated` and `service_role` only.
- All arithmetic stays in SQL; architecture tests in `src/test/architecture/` are extended in the same change as any new surface.
- Verification is `npx tsgo --noEmit -p tsconfig.app.json` (the solution-style `tsconfig.json` checks nothing) plus the consolidation SQL suites run one file at a time.
- This is an external Supabase project, so the sandbox cannot mint a signed-in session; anything that genuinely needs a logged-in click is reported as such rather than claimed green.

---

The standards sections below (test data, no shallow implementations, accounting accuracy, business-event reasoning, idempotence, resource-aware migrations, verification before completion) carry forward unchanged from the previous plan and continue to govern this work.
