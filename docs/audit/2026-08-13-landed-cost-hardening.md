# Landed Cost — Phase 6.2 hardening closeout

## What was added

`supabase/tests/landed_cost_hardening_test.sql` — introspection plus read-only
probes over the whole domain, in the project's existing test style. It asserts:

1. One writer per operation, one overload each (`landed_cost_allocate_voucher`,
   `landed_cost_post_voucher`, `landed_cost_reverse_voucher`,
   `_landed_cost_post_apply`).
2. `landed_cost_post_voucher` is a gate: it routes through `approval_route`,
   asserts business access, and delegates ledger work to the private applier —
   and that applier is not executable by `anon`/`authenticated`.
3. The approval mirror is the only automatic approved→posted route and it
   re-asserts `governance_assert_not_self`; the self-approval trigger is attached.
4. FX is stamped by `fx_stamp_document` (refusal, never parity), posted vouchers
   cannot be re-rated, and allocation refuses a voucher with no rate.
5. Allocation is deterministic (stable line order), absorbs rounding drift, and
   clears prior allocations before re-running.
6. Posting uses `inventory_apply_cost_revaluation` + `post_journal_entry_atomic`,
   credits landed cost clearing, checks the period lock, is idempotent, and
   refuses an expensed remainder with no COGS account.
7. Reversal requires a reason, unwinds inventory, compensates through the shared
   journal writer, and never deletes journal history.
8. `landed_cost.post` / `landed_cost.reverse` are in `governance_action_registry`.
9. The three server-side reporting helpers exist, so no client aggregates.
10. Live-data invariants: posted vouchers have a journal; reversed vouchers are
    fully unwound; no posted voucher sits at a null/zero rate; every landed-cost
    journal balances; `capitalized + expensed` equals the capitalisable
    allocation total; no orphaned allocations.

All probes were executed against the live database and pass.

## Defect found and fixed

`public._landed_cost_post_apply(uuid, uuid)` carried `EXECUTE` for `anon` and
`authenticated`. Because it lives in `public`, PostgREST exposed it as an RPC —
any signed-in user could have posted a voucher directly, bypassing
`approval_route` and the self-approval guard. A migration revoked execute from
`PUBLIC`/`anon`/`authenticated` and granted it to `service_role` only. Probe 2
now locks this in permanently.

The remaining `_landed_cost_*` functions are `RETURNS trigger` and are not
reachable over the Data API.

## Status

Phase 6.1 (reporting surfaces) and Phase 6.2 (hardening) are complete. Vitest
architecture guards `landed-cost.test.ts` and `landed-cost-currency.test.ts`
still pass.
