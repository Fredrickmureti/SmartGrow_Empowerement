# Consolidation — authoritative project status (updated 2026-08-28, 10:4x UTC)

This file is the single source of truth for where the consolidation capability
stands. It supersedes every archived plan under `.lovable/plan/`. The narrative
build history lives in `.lovable/consolidation-brick-log.md`; this file records
**status**, not story.

Live target: Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`).

---

## Standing mandate — every brick is an accounting brick

Non-negotiable for all remaining work. A brick is not done because a screen
renders; it is done when it would survive an audit in the way Microsoft Dynamics
365 Finance, Oracle NetSuite or SAP would model it:

1. **One engine per accounting question.** No second derivation of a balance,
   rate or elimination anywhere — UI and reports project server results, they do
   not compute them. No `reduce`/arithmetic over financial rows in components.
2. **Debits equal credits, always.** Every generated set balances in
   presentation currency or is explicitly refused with a stated reason. Never
   silently one-sided, never a rounding plug.
3. **Standards, named.** IAS 21 / ASC 830 translation and CTA, IFRS 10 /
   ASC 810 consolidation scope, elimination of intra-group balances, activity
   and unrealised profit, NCI at the level the standard requires.
4. **Period control.** Nothing may post into, or re-derive over, a closed fiscal
   period. The platform primitive `is_period_locked` is the only lock.
5. **Accountable and reversible.** Who, when, on what basis, what it replaced,
   and how to withdraw it — recorded append-only, never edited.
6. **Evidence, not assertion.** Every figure drills to the posted journal
   entries behind it, gated server-side by the viewer's access to that company.
7. **Security posture.** Caller-facing functions SECURITY INVOKER with pinned
   `search_path`, `anon` revoked, org-role authorisation server-side; DEFINER
   only for guard/audit triggers.
8. **No scaffolding.** No disabled controls, no placeholder tabs, no half-wired
   workflow shipped ahead of its brick.

---

## Fully implemented and verified

Verified this session against the live database and the repo — not taken from
the log.

- **Bricks 1–6 — the engine.** Group/member scope resolution with blockers,
  member translation, translated trial balance, consolidated statement lines and
  totals (plain and `_eliminated`), CTA reconciliation, refusal on unmapped
  accounts, intercompany balances / activity / coverage / flows / entry lines.
  All caller-facing functions are INVOKER; only guard/audit triggers and
  `consolidation_scope_member_count` are DEFINER.
- **Brick 7.1–7.2 — elimination generation.** Server-authorised (org
  owner/admin/super_admin, `42501` otherwise), reads intercompany flows rather
  than re-deriving balances, and produces a balanced set or refuses.
- **Brick 7.3 — default elimination policy templates.** Seeded per class,
  labelled System default / Customised / Not configured; reseed is additive and
  never destructive. Cross-currency residual carried to translation reserve
  (IAS 21 / ASC 830); same-currency disagreement refused.
- **Brick 7.4 — drill-down evidence.** `consolidation_elimination_evidence` and
  `consolidation_intercompany_entry_lines`; flows rebuilt as a pure aggregation
  of the entry-level reader so summary and detail cannot disagree. Ledger links
  appear only where the server set `viewer_can_open_ledger`. Statement →
  eliminations path carries identity, not arithmetic.
- **Brick 7.5 — accountable, reversible elimination events (this session).**
  - `consolidation_elimination_events`: append-only history (organisation,
    group, period, action, actor, timestamp, scope snapshot, rule snapshot,
    leg counts and totals, replaced totals, reason). Engine-only writes via
    `_consolidation_eliminations_engine_only`; RLS read for the same org roles
    that may generate; grants to `authenticated` / `service_role`.
  - `consolidation_generate_eliminations` extended: refuses when any month in
    the requested range is locked for any member business, and writes exactly
    one event per run in the same transaction, including replaced totals.
  - `consolidation_reverse_eliminations(group, from, to, reason)`: INVOKER,
    same authorisation, requires a non-empty reason, refuses on a locked period
    and on nothing-to-reverse, deletes the set and records the event.
  - Surface: History section on the eliminations report, Withdraw action behind
    a reason dialog, both gated on the same permission the server enforces.
  - Both functions confirmed INVOKER with `anon` execute revoked. `tsgo` clean,
    build OK.
- **Traceability wave.** Entity-aware `DrillDownDialog` across all five
  consolidation surfaces, `docs/consolidation-traceability-lineage.md`, and the
  architecture suites for statements, trial balance, mapping, intercompany,
  eliminations, cross-entity drill and artifact integrity.
- **Housekeeping.** The unrelated red tree in `src/pages/finance/AccountsPayable.tsx`
  (`toneBorder/toneSurface/toneText("warn")` → `warning`) is fixed.

---

## Pending — carried debt from Step 7.5, must be cleared first

Step 7.5's behaviour shipped; three items from its own definition of done did
not. They are the **first** work of the next session, not optional polish.

1. **`supabase/tests/consolidation_elimination_events_test.sql` does not exist.**
   Required coverage: append-only posture (no update/delete grant, engine-only
   insert), INVOKER + pinned `search_path` + `anon` revoked on both functions,
   one event per generation with totals equal to the produced set, a
   regeneration recording replaced totals, a reversal emptying the set and
   recording it, a locked period refusing both generate and reverse, and another
   organisation's member seeing nothing.
2. **Architecture test not extended.** `src/test/architecture/consolidation-eliminations.test.ts`
   still asserts nothing about history or reversal. Add: no arithmetic in the
   history component, the reversal affordance behind the server's permission
   flag, refusals rendered as explanation rather than an empty table.
3. **Locked-period refusal is not surfaced as a panel.** The database refuses
   correctly, but `ConsolidationEliminations.tsx` has no locked-period branch —
   the user meets a raw error instead of "period closed for <company>", in the
   existing refusal-panel pattern used for scope blockers.
4. **No `consolidation_elimination_history` RPC** — the surface reads the events
   table directly under RLS. Acceptable and deliberate (it is a read of rows the
   server already governs, not a new accounting question), but record the
   decision in the brick log so the next agent does not "fix" it.
5. **Brick-log checkpoint for 7.5 was never appended.** Append it, including the
   correction that no audit trail existed before this step.

## Pending — remaining roadmap

- **Step 7.6 — realistic scenario proof.** Independent companies, cross-currency,
  differing charts of accounts, an intercompany sale, reciprocal payable /
  receivable, CTA, a period boundary, and re-run idempotence. Proof by execution
  against seeded data, recorded with figures.
- **Numeric tie-out of the rebuilt flows against the stored August 2026 run.**
  Blocked in the sandbox: the invoker chain refuses an anonymous caller and this
  is an external Supabase project where no preview session can be minted. Must
  be run by a signed-in accountant before that period is relied on.
- **Brick 8 — persisted, versioned runs.** `consolidation_runs` with stored
  result rows and a version graph, built *on top of* the 7.5 event trail, not
  replacing it. Reopen/supersede semantics, immutable published versions.
- **Brick 9 — ownership and non-controlling interests.** Ownership percentages
  over time, acquisition/disposal dates, full vs equity vs proportionate method,
  investment-versus-equity elimination, NCI in equity and in profit or loss.
- **Brick 10 — consolidated cash flow statement**, derived from the consolidated
  movement, not a re-derivation from member cash books.

---

## Currently active phase

**Brick 7 — eliminations.** Steps 7.1–7.5 are functionally complete; Brick 7 is
**not closed** until the five pending items above are cleared and Step 7.6
passes.

## Next task

In order, no substitutions:

1. Clear Step 7.5's carried debt (items 1–5 in "Pending — carried debt").
2. Step 7.6 realistic scenario proof.
3. Declare Brick 7 closed in the brick log with evidence.
4. Begin Brick 8.

---

## Instructions for the next agent

**Verify before you build. Do not trust this file's "verified" column blindly —
it was written by the agent who did the work.**

1. **Re-verify Step 7.5 against the live database and the repo**, the same way
   this session re-verified 7.1–7.4:
   - `consolidation_elimination_events` exists with the stated columns, RLS
     enabled, engine-only write trigger attached, and no update/delete grant to
     `authenticated`.
   - `consolidation_generate_eliminations` and `consolidation_reverse_eliminations`
     are INVOKER, pin `search_path`, have `anon` revoked, authorise on org role,
     and genuinely consult `is_period_locked` for **every** member business
     across **every** month the range touches.
   - A generation writes exactly one event, and totals on the event equal the
     legs actually produced. A regeneration records what it replaced. A reversal
     leaves no set behind.
   - The surface computes nothing: grep the history component and the report for
     arithmetic over financial rows.
   If any of that is false, fix it before adding anything new, and correct this
   file.
2. **Then resume from "Next task" above** — carried debt first, then 7.6. Do not
   start Brick 8 or 9 early, and do not wander into unrelated domains
   (banking, payroll, POS, inventory) however tempting a red tree looks; fix
   only what blocks a green build.
3. **Every change must satisfy the standing mandate at the top of this file.**
   A brick that renders but cannot be audited is not done.
4. **Definition of done for any step here:** live-database verification stated
   with figures, a `supabase/tests/*.sql` posture + behaviour test, the
   architecture vitest suite extended, `npx tsgo --noEmit -p tsconfig.app.json`
   clean (the solution `tsconfig.json` checks nothing — always pass
   `-p tsconfig.app.json`), the consolidation vitest suites green, a checkpoint
   appended to `.lovable/consolidation-brick-log.md`, and this file updated.
5. **State plainly what you did not verify and why.** The tie-out above is the
   template: an honest blocked item is worth more than a claimed pass.
