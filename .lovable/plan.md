# Consolidation — verification verdict (2026-08-26 late) and Brick 2 execution plan

Authority: this file. Everything under VERIFIED below was proven this session by
direct inspection of the live database and the codebase, not inherited from the
previous engineer's notes.

## Roadmap (chronological — do not reorder or skip)

| Brick | Scope | Status |
|-------|-------|--------|
| 0 | Comparative cross-company view on the authoritative engine | DONE (with one debt item, B0-1 below) |
| 1 | Group + ownership foundation (config, guards, audit, RLS) | DONE (with three debt items, B1-1..B1-3) |
| 2 | Consolidated trial balance over a group, one presentation currency | NEXT — nothing built yet |
| 3 | FX translation (closing/average/historical rates, CTA) | Blocked by Brick 2 |
| 4 | Intercompany identification + elimination engine | Blocked by Brick 3 |
| 5 | Consolidated statement presentation + drill-down + runs | Blocked by Brick 4 |

## Phase 1 — independent verification of the previous engineer's claims

### VERIFIED as genuinely done
- Live database: `_consolidation_group_guard`, `_consolidation_member_guard`,
  `_consolidation_group_log`, `_consolidation_member_log` all exist as SECURITY
  DEFINER functions and are attached as triggers on `consolidation_groups` and
  `consolidation_group_members` (4 triggers confirmed). `close_consolidation_member`
  exists as an RPC.
- RLS is real and cross-business aware: read requires `is_org_member` **and**
  `user_can_access_business`; writes additionally require an org role of
  owner/admin/super_admin. Change log is SELECT-only for signed-in users and is
  further gated on access to the group's parent company.
- `consolidation_exchange_rates` / `consolidation_rate_type` are indeed absent —
  the premature placeholder really was removed. No Brick 2–5 phantom schema exists.
- Client surface exists and is reachable: `ConsolidationGroupsSettings.tsx` is
  imported and rendered by `src/pages/finance/FinanceSettings.tsx` (lines 32, 134).
- `src/test/architecture/consolidation-group-foundation.test.ts` — executed here,
  9 tests pass.
- The comparative report at `/reports/consolidation` (`src/App.tsx:365`,
  `src/pages/reports/Consolidation.tsx`) is a real route and does read posted GL
  through `fetchGLTotals` → `get_account_movements`. It does not sum across
  entities, apply FX, or eliminate anything — that honesty is correct and must be
  preserved until Brick 2 exists.

### Claims corrected / debt found (treated as pending work, not "done")
- **B1-1 — stale `as never` cast.** The plan says `close_consolidation_member` is
  missing from generated types. It is present (`src/integrations/supabase/types.ts`
  around line 93975). The cast in `src/hooks/finance/useConsolidationGroups.ts:274`
  is now unnecessary and hides type errors. Remove it.
- **B1-2 — membership write policy does not require access to the parent.**
  `consolidation_group_members_write` checks `user_can_access_business(member)` but
  not access to the group's `parent_business_id`, while `consolidation_groups_select`
  does. An org admin who can access company B but not parent A can therefore attach
  B to A's group. Tighten the policy (or the guard) to require access to the parent
  as well.
- **B1-3 — SQL suite never executed.** `supabase/tests/consolidation_group_foundation_test.sql`
  has still not been run against a database. Guards are only proven by their
  refusals; run it (or port the assertions to a runnable harness) before Brick 2
  layers on top of them.
- **B0-1 — statement classification duplicated in `fetchGLTotals`.**
  `src/services/gl/fetchGLTotals.ts` re-implements income/expense sign
  normalisation in JavaScript from raw `get_account_movements` rows, while the
  authoritative statement path is `src/hooks/useFinancialReport.ts` +
  `src/services/reports/ReportCalculationEngine.ts` + `AccountClassification.ts`.
  That is two classification implementations — exactly what section 10 of the
  brief forbids. Brick 2 must consume the authoritative classification, and the
  comparative page should be moved onto it too.
- **B0-2 — inconsistent view permission.** The report page hardcodes
  `owner || super_admin` for viewing, while group configuration writes allow
  owner/admin/super_admin and RLS governs reads. Consolidation viewing needs one
  defined permission, checked server-side, not a hardcoded role list in a page.
- **B0-3 — N sequential client round trips.** The comparative page loops
  `fetchGLTotals` once per company from the browser. Acceptable for side-by-side;
  not acceptable as Brick 2's aggregation path.

## Phase 2 — plan corrections and additions

Added to the roadmap on the evidence above:
1. Brick 2 gets a **server-side** group/date resolver and aggregation path; no
   per-company client fan-out and no JavaScript re-derivation of account
   classification.
2. A single `consolidation.view` authorization decision, resolved server-side and
   consistent with the RLS that already governs the group tables (fixes B0-2).
3. Brick 1 debt (B1-1..B1-3) is closed **before** Brick 2 code lands, because
   Brick 2's correctness depends on those guards being proven.
4. Period integrity is explicit in Brick 2: membership effective dates and fiscal
   period state (closed/open) must both be respected, and a member with no posted
   period data must be reported as such rather than silently contributing zero.

## Brick 2 — exact scope (the only thing to build after the debt items)

Deliverable: a **consolidated trial balance** for one consolidation group as of a
date range, in the group's presentation currency, refusing to run when it cannot
be produced honestly.

1. **Group resolution (server-side, SQL).** Resolve the group's members as of the
   reporting date from effective-dated membership: company, ownership percentage,
   consolidation method. Enforce that the caller can access **every** company in
   scope; refuse the whole run otherwise (never silently drop a company).
2. **Balances from the authoritative engine only.** Per member, opening balances
   from `get_ledger_opening_balances` and period movements from
   `get_account_movements`. No new balance mathematics.
3. **Classification from the authoritative source.** Account type/classification
   comes from `AccountClassification` / `ReportCalculationEngine`, not a new map.
4. **Method semantics.** `full` contributes 100% of member balances and records
   the non-controlling share separately as a distinct, labelled figure. `equity`
   contributes a single equity-method line, never member account balances.
5. **Refuse, never approximate.** Blocking conditions surfaced as explicit,
   actionable UI errors: any member whose base currency differs from the group's
   presentation currency (needs Brick 3), missing/ambiguous membership, ownership
   that cannot be resolved, unauthorized company in scope.
6. **No eliminations, no FX, no CTA, no consolidated statements, no persisted
   runs** in this brick. Cross-entity intercompany balances stay visible and
   uneliminated, and the report says so on its face.
7. **UI.** One report in the finance reports area: group picker (only groups the
   user may read), date range, per-account group total with per-member columns so
   every figure is traceable to its source company.
8. **Tests.** Architecture tests: no second balance/classification engine, no
   client fan-out, refusal paths present. Behavioural tests: mixed-currency group
   refuses; `equity` member contributes no account balances; a company the user
   cannot access blocks the run; membership closed mid-period is excluded from the
   correct date onward.

## Checkpoint discipline

Brick 2 closes only when resolver, authorization, report UI, refusal paths and
tests are all in place, and this file is updated with the VERIFIED evidence for
each. Bricks 3–5 stay untouched until then — including their schema and UI.

## Note on the Supabase connection request

The project is already connected to an external Supabase project (ref
`jkszmrroyjfdwokbkzis`), which is where all the verification above was run.
Lovable cannot switch that link from inside a chat; if `AccrualFlowCorporation`
is a different project, it must be re-linked from the Cloud/integration settings.
