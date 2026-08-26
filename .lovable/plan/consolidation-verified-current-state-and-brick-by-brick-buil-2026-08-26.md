# Consolidation — Verified Current State and Brick-by-Brick Build Plan

Everything below was re-verified against the live database and the checked-out code in
this session. Prior notes were treated as hearsay; corrections are marked.

## 1. Verified current state

**The comparative report is already on the authoritative engine.** `src/pages/reports/Consolidation.tsx`
reads per-company totals through `fetchGLTotals` → the `get_account_movements` RPC (the same
posted-GL engine behind Trial Balance and P&L), and resolves the company list through the
`get_user_allowed_businesses` RPC rather than the raw `businesses` table. There is no
JavaScript re-summation of `journal_entry_lines` left in this page.
*Correction:* the earlier note claiming duplicate accounting math and org-only company
listing is out of date.

**It has been moved out of Settings.** Registered at `/finance/reports/cross-company`
(`src/apps/finance/routes.tsx:677`), listed in `ReportRegistry.ts:621` as
"Cross-Company Comparative", and `src/apps/platform/nav.ts:75` records that it is a report,
not a setting. *Correction:* the "wrong placement" finding is resolved.

**Consolidation tables now exist.** Three migrations dated 2026-08-26 created
`consolidation_groups`, `consolidation_group_members` (enum `consolidation_method`:
full / proportional / equity / excluded) and `consolidation_exchange_rates` (enum
`consolidation_rate_type`: closing / average / historical).
*Correction:* the claim "zero consolidation tables, functions, or migrations" is false.

What those migrations genuinely got right (read line by line): RLS enabled on all three;
SELECT gated by `is_org_member` **and** `user_can_access_business`; writes additionally
gated on owner/admin/super_admin org roles; `SECURITY DEFINER` guard triggers that verify
same-organization membership for group, member and parent company, validate the
presentation currency against `public.currencies`, walk the ownership chain to reject
cycles and excessive depth, and refuse `method = 'full'` below 50% ownership; check
constraints on ownership range, effective-date order and self-parenting; a partial unique
index enforcing one open membership per company per group. Table grants for
`authenticated` and `service_role` are present (an earlier read of mine suggesting missing
grants was a bad query — `relacl` confirms them).

### Verified defects that make Brick 1 incomplete

1. **The configuration UI is unreachable.** `src/components/settings/ConsolidationGroupsSettings.tsx`
   exists and is exported, but no file in the repository imports it. There is no route, no
   settings tab, no nav entry. The capability is invisible to users.
2. **A premature placeholder table shipped.** `consolidation_exchange_rates` and the
   `consolidation_rate_type` enum have **zero consumers** anywhere outside generated types.
   That is Brick 4 scaffolding created before Brick 1 was validated — exactly what the brief
   forbids.
3. **Zero tests.** No file under `src/test/` or `supabase/tests/` (213 SQL tests exist)
   references any consolidation object. None of the guard triggers or RLS policies is proven.
4. **No audit trail.** `created_by` is nullable and never populated by the client hook;
   changes to ownership percentage, method or effective dates leave no history, even though
   group membership is an accounting-significant configuration.
5. **Membership close-out semantics are missing.** `removeMember` hard-deletes the row.
   Ownership history must be closed by setting `effective_to`, not erased, or a past-period
   consolidation can never be reproduced.
6. **Presentation currency is validated against the platform catalogue only**, not against
   the parent company's enabled operating currencies (`business_active_currencies`), which is
   how every other document currency in this system is constrained.
7. **Never exercised.** Live data: 2 organizations, 2 companies, 1 currency, 17 journal
   entries, 0 consolidation groups. Multi-currency and partial-ownership paths have no data.
8. Minor: `src/contexts/BusinessContext.tsx:263` still points users at the retired
   `/reports/consolidation` path in an error message.

## 2. Architecture being built

```text
Organization (tenant boundary, RLS)
  └── Business = legal entity: owns COA, GL, fiscal calendar, base currency
        └── Branch = sub-ledger dimension only (never a consolidation entity)

Consolidation group  ── scope + ownership + method + presentation currency
        ↓ account mapping
        ↓ FX translation (closing / average / historical) → CTA
        ↓ intercompany identification → eliminations
        ↓ consolidation run (persisted, versioned, auditable)
   Consolidated statements ── drill-down to source entity and journal
```

Rules that hold for every brick: the GL stays the only accounting truth; statements are
produced by the existing SQL reporting engine, never re-derived in the browser; the existing
single FX rate resolver is extended, not duplicated — consolidation rate types are a distinct
concern from transaction rates and live in their own table, read by server-side code only;
no cross-business figure is ever assembled without proving the caller can access every
company in scope, server-side.

Grounding: IFRS 10 / ASC 810 for scope and control, IAS 21 / ASC 830 for closing-rate
assets and liabilities, average-rate income, historical-rate equity and the residual to CTA.
Pattern references: NetSuite consolidated exchange rates and elimination subsidiaries,
D365 consolidation legal entity with account mapping, Workday ownership hierarchy with
bundled CTA/NCI, Odoo account mapping in configuration with a separate consolidation journal.

## 3. Brick order

1. **Brick 1 — group and ownership foundation** (this wave; finish and prove what exists).
2. Brick 2 — configuration surface hardening: activation/deactivation lifecycle, scope
   validation, group readiness state.
3. Brick 3 — account mapping across differing charts of accounts.
4. Brick 4 — consolidation FX: rate types, presentation currency translation, CTA.
5. Brick 5 — consolidated statements from the authoritative engine, with drill-down.
6. Brick 6 — intercompany identification (trading-partner dimension on journal lines).
7. Brick 7 — elimination engine: deterministic, explainable, reversible.
8. Brick 8 — persisted consolidation runs and full audit trail.

No work starts on a brick until the previous one is complete and tested.

## 4. Brick 1 — exact scope of this wave

Goal: a consolidation group is something a user can actually create, see, correct and audit,
with every rule enforced in the database and proven by tests. No reporting behaviour changes.

Database (separate small single-purpose migrations, per project convention):
- Extend `_consolidation_group_guard` to require the presentation currency to be an enabled
  operating currency of the parent company, and to stamp `created_by` from `auth.uid()`.
- Extend `_consolidation_member_guard`: reject overlapping effective periods for the same
  company in the same group (the current partial unique index only covers open rows); require
  that the declared `parent_business_id` is itself a member of the group; forbid the parent
  company of the group being given a parent within the group; forbid mutating
  `business_id`/`group_id` after insert; stamp `created_by`.
- `consolidation_group_change_log` (append-only, org-scoped, RLS mirroring the parent tables)
  written by triggers on both tables, recording actor, action, before/after ownership,
  method and effective dates.
- Membership close-out: an RPC `close_consolidation_member(_id, _effective_to)` that sets
  `effective_to` with validation; deletion allowed only for a membership that has never been
  used by a consolidation run (trivially true today, and the check stays honest later).
- **Drop `consolidation_exchange_rates` and the `consolidation_rate_type` enum.** They are
  unreferenced placeholders and will be reintroduced in Brick 4 with the resolver that gives
  them meaning. (Zero rows, so nothing is lost.)

Application:
- Make the configuration reachable: a Finance settings route/tab rendering
  `ConsolidationGroupsSettings`, gated on the same owner/admin roles the RLS write policy
  enforces, plus a permission check — the UI must not offer actions RLS will refuse.
- Company pickers restricted to companies from `get_user_allowed_businesses`, not the raw
  org list, so a group can never be defined over a company the user cannot access.
- Route `removeMember` through the close-out RPC; surface effective-dated membership history
  in the UI instead of hiding it.
- Fix the stale `/reports/consolidation` reference in `BusinessContext.tsx`.

Tests:
- `supabase/tests/consolidation_group_foundation_test.sql`: cross-org group rejected;
  cross-org member rejected; ownership cycle rejected; `full` below 50% rejected; overlapping
  effective periods rejected; unknown/non-enabled presentation currency rejected; parent not
  in group rejected; change log written on insert/update; close-out sets `effective_to` and
  permits a later membership.
- RLS tests: a user with access to company A only cannot read or write a group whose parent
  is company B; a non-member of the organization sees nothing; a plain member (no admin role)
  can read but not write.
- `src/test/architecture/consolidation-single-engine.test.ts`: consolidation code may not
  select `journal_entries`/`journal_entry_lines` directly and may not define its own FX
  resolver — group data reaches the app only through the sanctioned tables and RPCs.

Definition of done for Brick 1: all tests green, the settings surface reachable and role-gated,
change log populated, no unreferenced consolidation object left in the schema, and a written
checkpoint recording what is enforced, what is intentionally absent, and what Brick 2 depends on.

## 5. Explicitly out of scope this wave

Account mapping, any FX translation or CTA, intercompany dimensions, eliminations,
consolidation runs, consolidated statements, minority interest. The comparative report keeps
its current behaviour and its honest disclaimer; nothing sums across companies.
