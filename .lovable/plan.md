# Consolidation — execution status (verified, not inherited)

Authority: this file. Every statement marked VERIFIED was proven by direct
inspection on 2026-08-26, not copied from a prior agent's claims. Prior claims
were re-checked and several were wrong; corrections are recorded inline.

## Roadmap (chronological — do not reorder or skip)

| Brick | Scope | Status |
|-------|-------|--------|
| 1 | Group and ownership foundation | **DONE** |
| 2 | Consolidated trial balance over the group | **NEXT — not started** |
| 3 | FX translation (different base currencies) | Pending, blocked by Brick 2 |
| 4 | Intercompany elimination | Pending, blocked by Brick 3 |
| 5 | Consolidated statement presentation | Pending, blocked by Brick 4 |

**Currently active phase: none in flight.** Brick 1 is closed. The next task is
Brick 2 (below). No Brick 2 code exists yet — confirmed: no aggregation engine,
no group resolver, no new RPCs beyond Brick 1's.

---

## Brick 1 — group and ownership foundation: DONE

### VERIFIED (database)
- `consolidation_groups`, `consolidation_group_members` hardened by
  `_consolidation_group_guard` / `_consolidation_member_guard`: same-organization
  coherence, presentation currency must be an **enabled operating currency** of
  the parent company, `full` method requires >= 50% ownership, declared parent
  must be a member for the same period, no ownership cycles, no overlapping
  membership periods for one company, `business_id` / `group_id` immutable after
  insert, `created_by` stamped from `auth.uid()`.
- `consolidation_group_change_log` records every group/member insert, update and
  delete through SECURITY DEFINER triggers; signed-in users hold SELECT only.
  (Migrations: `20260826185735_…`, `20260826190142_…`.)
- `close_consolidation_member(uuid, date)` ends a membership with an effective
  date instead of deleting it; a later non-overlapping membership is then
  permitted, so ownership history stays reproducible.
- Premature placeholder removed: `consolidation_exchange_rates` and
  `consolidation_rate_type` dropped. They return with Brick 3's translation
  engine that gives them meaning, not before.

### VERIFIED (client)
- `src/hooks/finance/useConsolidationGroups.ts` — write access gated by
  `useCanManageConsolidation` (matches the RLS write policy), companies
  restricted to `get_user_allowed_businesses`, `useConsolidationChangeLog`
  read-only, `closeMember` routed through the RPC.
- `src/hooks/useBusinessCurrencies.ts` — `useBusinessCurrenciesFor(businessId)`
  resolves the enabled operating currencies of the chosen parent.
- `src/components/settings/ConsolidationGroupsSettings.tsx` — reachable,
  imported and rendered by `src/pages/finance/FinanceSettings.tsx` (lines
  32, 131–134). No longer an orphan component.
- `src/contexts/BusinessContext.tsx` — stale wording removed from the
  `switchBusiness` error.

### VERIFIED (tests)
- `supabase/tests/consolidation_group_foundation_test.sql` — every guard
  asserted by the refusal it raises, plus change-log recording, close-out
  semantics, cross-tenant RLS isolation and an over-block check for the owner.
- `src/test/architecture/consolidation-group-foundation.test.ts` — passing:
  screen reachability, no hard delete of membership, authoritative pickers, no
  ledger reads or accounting arithmetic in the configuration surface, no stale
  route reference.

### Corrections to prior claims (recorded honestly)
- `/reports/consolidation` is **not** a non-existent path. It is a real route
  (`src/App.tsx:365`) rendering `src/pages/reports/Consolidation.tsx`, the
  legitimate side-by-side cross-company comparative view fed by the
  authoritative `fetchGLTotals` / `get_account_movements` RPC. `Dashboard.tsx`,
  `CompanyScopeGate.tsx` and several report hooks reference it correctly. The
  prior audit's "stale route" finding and the earlier "zero consolidation
  tables" finding were both wrong.
- The comparative view is intentionally NOT a consolidation engine: no summing
  across entities, no FX, no eliminations. Brick 2+ must not regress this —
  until the group engine exists, side-by-side is the only honest cross-company
  display.

### Residual gap (honest)
- The SQL suite has not been executed against a database in this environment
  (no local stack here); it runs under `supabase test db`.
- `close_consolidation_member` is not yet in the generated Supabase TypeScript
  types; the hook uses an `as never` cast as a temporary bridge. Regenerate
  types and remove the cast.
- The DB linter reports ~3,711 pre-existing security findings (mostly legacy
  SECURITY DEFINER functions missing `search_path`). Not introduced by Brick 1;
  do not fold them into consolidation work — track separately.

---

## Brick 2 — NEXT: consolidated trial balance over the group

Scope when started:
- Resolve group membership as of a reporting date (ownership + method + period,
  using the effective-dated membership Brick 1 now guarantees) and feed the
  **existing** authoritative engine (`get_account_movements` /
  `get_ledger_opening_balances`) once per member company. No second accounting
  engine, no JavaScript aggregation of ledger rows.
- Method semantics: `full` includes 100% of balances with a non-controlling
  interest split; `equity` contributes a single equity-method line, not member
  balances.
- Refuse rather than approximate: a member whose base currency differs from the
  group's presentation currency blocks the run until Brick 3 (translation)
  exists. Surface this as an explicit, actionable error in the UI.
- Deliverable shape: a consolidated trial balance report reachable from the
  finance reports area, a group/date/method resolver (server-side), and tests
  proving the resolver feeds only the authoritative RPCs and that
  currency-mismatched groups refuse to run.

## Scope boundaries

No FX translation (Brick 3), no intercompany elimination (Brick 4), no
consolidated statement presentation (Brick 5) until the brick below it is
proven. No premature placeholders: schema and UI for a later brick may not be
added before that brick is being built.

---

## Instructions for the next agent

1. **Verify before building.** Do not trust this file or any prior audit
   blindly. Before writing new code, independently confirm:
   - The Brick 1 migrations are applied and the guard functions, change-log
     triggers and `close_consolidation_member` RPC exist in the live database
     (query `information_schema` / `pg_proc`, or run the SQL suite).
   - `supabase/tests/consolidation_group_foundation_test.sql` actually passes
     (`supabase test db`) — it has not been executed here yet.
   - `src/test/architecture/consolidation-group-foundation.test.ts` passes.
   - The settings screen renders in Finance settings and behaves per the
     guards (drive it in the browser if in doubt).
   - Regenerate Supabase types and remove the `as never` cast on
     `close_consolidation_member`; confirm the RPC is typed.
   If any verification fails, fix that first — it is part of Brick 1, not new
   work.
2. **Then start Brick 2 exactly as scoped above.** It is the next chronological
   milestone. Do not start Bricks 3–5, do not refactor unrelated areas, and do
   not add placeholder schema/UI for later bricks.
3. **Engine discipline.** All figures must come from the existing authoritative
   RPCs (`get_account_movements`, `get_ledger_opening_balances`). A second
   JavaScript balance computation is a second source of accounting truth and is
   forbidden — the existing architecture tests enforce this pattern.
4. **Refuse, never approximate.** Currency mismatch (pre-Brick 3), missing
   membership data, or unverifiable ownership must block the run with a clear
   error, never produce a best-effort number.
5. **Finish Brick 2 coherently** — resolver, report UI, errors, and tests —
   and update this file (status table + VERIFIED evidence) before touching
   anything else. Keep execution chronological; leave no orphaned components,
   partial workflows, or unreachable screens.
