# Consolidation — execution status (verified, not inherited)

Authority: this file. Previous consolidation claims were re-checked directly and
several were wrong; only statements below marked VERIFIED were proven this wave.

## Brick 1 — group and ownership foundation: DONE

VERIFIED (database):
- `consolidation_groups`, `consolidation_group_members` hardened by
  `_consolidation_group_guard` / `_consolidation_member_guard`: same-organization
  coherence, presentation currency must be an **enabled operating currency** of the
  parent company, `full` method requires >= 50% ownership, declared parent must be a
  member for the same period, no ownership cycles, no overlapping membership periods
  for one company, `business_id` / `group_id` immutable after insert, `created_by`
  stamped from `auth.uid()`.
- `consolidation_group_change_log` records every group/member insert, update and
  delete through SECURITY DEFINER triggers; signed-in users hold SELECT only.
- `close_consolidation_member(uuid, date)` ends a membership with an effective date
  instead of deleting it; a later non-overlapping membership is then permitted, so
  ownership history stays reproducible.
- Premature placeholder removed: `consolidation_exchange_rates` and
  `consolidation_rate_type` dropped. They return with the translation engine that
  gives them meaning, not before.

VERIFIED (client):
- `src/hooks/finance/useConsolidationGroups.ts` — write access gated by
  `useCanManageConsolidation` (matches the RLS write policy), companies restricted to
  `get_user_allowed_businesses`, `useConsolidationChangeLog` read-only,
  `closeMember` routed through the RPC.
- `src/hooks/useBusinessCurrencies.ts` — `useBusinessCurrenciesFor(businessId)`
  resolves the enabled operating currencies of the chosen parent.
- `src/components/settings/ConsolidationGroupsSettings.tsx` — reachable, rendered by
  `src/pages/finance/FinanceSettings.tsx` (no longer an orphan component).
- `src/contexts/BusinessContext.tsx` no longer advertises the non-existent
  `/reports/consolidation` path.

VERIFIED (tests):
- `supabase/tests/consolidation_group_foundation_test.sql` — every guard asserted by
  the refusal it raises, plus change-log recording, close-out semantics, cross-tenant
  RLS isolation and an over-block check for the owner.
- `src/test/architecture/consolidation-group-foundation.test.ts` — 9 passing: screen
  reachability, no hard delete of membership, authoritative pickers, no ledger reads
  or accounting arithmetic in the configuration surface, no stale route.

Residual gap (honest): the SQL suite has not been executed against a database in this
environment (no local stack here); it runs under `supabase test db`.

## Brick 2 — next: consolidated trial balance over the group

Scope when started:
- Resolve group membership as of a reporting date (ownership + method + period) and
  feed the **existing** authoritative engine (`get_account_movements` /
  `get_ledger_opening_balances`) once per member company. No second accounting engine,
  no JavaScript aggregation of ledger rows.
- Method semantics: `full` includes 100% of balances with a non-controlling interest
  split; `equity` contributes a single equity-method line, not member balances.
- Refuse rather than approximate: a member whose base currency differs from the
  group's presentation currency blocks the run until Brick 3 (translation) exists.

## Scope boundaries

No intercompany elimination (Brick 4), no FX translation (Brick 3), no consolidated
statement presentation (Brick 5) until the brick below it is proven.
