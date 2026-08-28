# Consolidation — verified handover (2026-08-28, 10:2x UTC) and Step 7.5

## Phase 1 — what I verified myself (not from the log)

Checked against the live `AccrualFlowCorporation` database (ref `jkszmrroyjfdwokbkzis`) and the repo this session.

**Confirmed genuinely present**

- The full Brick 1–7 engine exists in the database: scope resolution, member translation, translated trial balance, consolidated statement lines/totals (plain and `_eliminated`), CTA reconciliation, unmapped-account refusal, intercompany balances/activity/coverage/flows/entry lines, elimination generation, diagnosis, balance check, default-rule seeding, and per-leg evidence. All caller-facing functions are SECURITY INVOKER; only the guard/audit triggers and `consolidation_scope_member_count` are DEFINER.
- Elimination generation is genuinely authorised server-side (org owner/admin/super_admin, `42501` otherwise) and reads intercompany flows rather than re-deriving balances — no second accounting engine.
- The traceability wave is real, not claimed: `DrillDownDialog` is entity-aware, all five consolidation surfaces drill in place, `docs/consolidation-traceability-lineage.md` exists, and the architecture suites for statements, trial balance, mapping, intercompany, eliminations, cross-entity drill and artifact integrity are present.

**Confirmed still absent — this is the real remaining work**

- **No audit trail of a generation event.** `consolidation_eliminations` carries only `generated_at` / `generated_by` on the surviving rows. Neither `consolidation_generate_eliminations` nor `consolidation_diagnose_eliminations` writes any history (verified: neither source mentions an audit write). Regenerating a period silently replaces the previous set; the question "who generated this, when, on what basis, and what did it replace?" has no answer.
- **No period control.** The database has `is_period_locked` / `is_period_open` / `enforce_fiscal_period_lock`, and consolidation references none of them. A closed fiscal period can be re-eliminated with no refusal and no record.
- **No reversal.** There is no way to withdraw a generated set other than overwriting it.
- **No persisted, versioned run** (`consolidation_runs` does not exist) — correctly, that is Brick 8 and stays out of this step.

**Unrelated red tree, fixed first:** `src/pages/finance/AccountsPayable.tsx` has 3 typecheck errors (`toneBorder/toneSurface/toneText("warn")` — the token is `warning`). The tree must be green before consolidation work is trusted.

## Phase 2 — plan corrections carried forward

- Step 7.5 as previously framed ("audit trail") and 7.6 ("period control and reversal") are one accounting concern, not two: a generation is only accountable if it is recorded, refused when the books are closed, and withdrawable. Splitting them would ship a log nobody can act on. They are merged into Step 7.5 below.
- The audit record is deliberately **not** a persisted run. It records the *event* and its basis; it does not store result rows or a version graph. Brick 8 builds on it rather than replacing it.
- Period control follows the existing platform primitive (`is_period_locked`), not a new consolidation-specific lock.

## Step 7.5 — Every elimination set is an accountable, reversible event

### Database (one small migration per object)

- `consolidation_elimination_events` — append-only history of every generation, reversal and refusal: organisation, group, period, action (`generate` / `regenerate` / `reverse` / `refused`), actor, timestamp, presentation currency, member scope snapshot (business ids and their translation rate basis), rule snapshot (class, tolerance, policy in force at run time), counts and totals of the legs produced, the difference legs carried, the replaced set's totals where it replaced one, and the refusal reason where it refused. RLS: readable by the same org roles that may generate; no client insert/update/delete — written only by the engine.
- `consolidation_generate_eliminations` extended, not rewritten: refuse with `42501`-style context when any month touched by the period is locked for any member business (`is_period_locked`); on success write the event row inside the same transaction, including the totals of the set it replaced.
- `consolidation_reverse_eliminations(group, from, to, reason)` — SECURITY INVOKER, same authorisation, deletes the generated set for that group and period and writes a `reverse` event carrying the reversed totals and the stated reason. Refuses on a locked period and refuses when there is nothing to reverse.
- `consolidation_elimination_history(group, from, to)` — reader for the surface, org-checked, `anon` revoked, grants matching the existing consolidation functions.

### Surface

- The eliminations report gains a **History** section: each event as a row (action, actor, timestamp, legs, debit/credit totals, difference legs, and for a regeneration what it replaced), with the rule and scope snapshot expandable. The current set is labelled with the event that produced it.
- **Reverse this set** next to Generate, behind a confirmation that requires a reason, visible only to a viewer the server would allow. After a reversal the page states plainly that the period has no generated set and why it was withdrawn — no empty table, no zero.
- A locked period disables generation and explains which member company's period is closed, using the existing refusal-panel pattern rather than a toast.

### Verification

- `supabase/tests/consolidation_elimination_events_test.sql`: append-only posture (no update/delete grant, engine-only insert), invoker + pinned `search_path` + `anon` revoked on both new functions, a generation writes exactly one event with totals equal to the set it produced, a regeneration records the replaced totals, a reversal empties the set and records it, a locked period refuses both generate and reverse, and another organisation's member sees nothing.
- Architecture test extended: no arithmetic in the history component, reversal affordance behind the server's permission flag, refusals rendered as explanation.
- `npx tsgo --noEmit -p tsconfig.app.json` (the solution `tsconfig.json` checks nothing — always use `-p tsconfig.app.json`), the five consolidation vitest suites, and a re-read of the live August 2026 set.
- Checkpoint appended to `.lovable/consolidation-brick-log.md`, including the correction that no audit trail existed before this step.

### Intentionally absent after this step

Persisted versioned runs with stored result rows (Brick 8), the numeric tie-out of the rebuilt flows against the stored August run (needs a signed-in accountant — this is an external Supabase project and the sandbox cannot mint a session), the realistic multi-scenario proof (Step 7.6), NCI/ownership and consolidated cash flow. No scaffolding or disabled controls for any of them.

## Remaining sequence after 7.5

7.6 realistic scenario proof (independent companies, cross-currency, differing charts, intercompany sale, reciprocal payable/receivable, CTA, period boundary, re-run idempotence) → Brick 8 persisted versioned runs → Brick 9 ownership/NCI, consolidated cash flow.
