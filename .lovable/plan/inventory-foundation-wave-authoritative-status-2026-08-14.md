# Inventory Foundation Wave — authoritative status

**Reference architecture:** ADR 0142 (single balance / availability / reservation),
ADR 0078 (AVCO canonical), ADR 0076 (stock event fabric), ADR 0064, ADR 0025.
**Ledgers:** `.lovable/plan/inventory-foundation-wave-execution-ledger-2026-08-14.md`
**Last updated:** 2026-08-14 (handover verification session #2)

## Status ledger

| Phase | Scope | State |
|---|---|---|
| 1 | Single balance store + single availability engine | VERIFIED (see re-open below) |
| 1b | `get_available_pos_stock_for_register` on the engine | VERIFIED |
| 2 | Single reservation engine + lifecycle | VERIFIED |
| 3 | Movement ledger completeness | VERIFIED |
| 4 | Costing & valuation guard (AVCO canonical) | VERIFIED |
| 5 | Lots / serials / expiry traceability closure | COMPLETE (structural) |
| 6 | Business events — one emitter, complete topics | VERIFIED (structural) |
| 7 | Availability repoint — server batch engine + UI | **IN PROGRESS** |
| 8 | Documentation + behavioural sweep | NOT STARTED |

## Verification performed this session

Re-checked directly against the live database, not against the ledger:

- `stock_movements` carries exactly one outbox emitter trigger
  (`trg_stock_movement_emit_event` → `tg_stock_movement_emit_event`); the legacy
  POS-only emitter is gone. **Phase 6 claim holds.**
- `inventory_movement_event_classes` = 15 rows, `emit_inventory_event` exists,
  8 server-scoped `inventory.*` topics, 4 lifecycle emitter triggers present.
  **Phase 6 claim holds.**
- Reservation engine, quant maintenance and valuation guards match the Phase 2/3/4
  ratchets in `supabase/tests/`. **Claims hold.**
- Tenant data is still empty (0 `stock_movements`, 0 `stock_quants`, 5 products),
  so every phase above remains a *structural* pass. Behavioural proof stays in Phase 8.

### New defect found — Phase 1 was closed too early

`resolve_stock_availability` is correct and canonical, but it is **single-product
only**. Every list surface therefore avoids it:

1. `list_products_with_branch_stock` — the RPC behind `useBranchScopedProducts`,
   product lists, and sales line validation — computes
   `SUM(warehouse_stock.quantity) - SUM(warehouse_stock.reserved_quantity)` itself.
   That is a **fifth availability formula, on the server**, blind to blocked,
   quarantine and transit locations. It contradicts ADR 0142 §3.
2. Two overloads of that function exist (3-arg and 4-arg); the 3-arg one is dead
   weight and will drift.
3. `src/lib/inventory/availability.ts#resolveAvailabilityFor` fans out one RPC per
   product — unusable for lists, which is *why* the surfaces bypass it.
4. Eight browser files still derive `quantity - reserved` locally
   (`availability-is-server-owned.test.ts` PENDING_MIGRATION).
5. `src/lib/replenishment/engine.ts` computes availability and net requirement in
   the browser — a business engine on the client (parent prompt §9).

## Phase 7 — availability repoint (execution plan)

**7a. Batch availability engine (server).**
Add `resolve_stock_availability_batch(p_product_ids uuid[], p_business_id,
p_branch_id, p_warehouse_id)` returning the same six columns per product, sharing
one implementation with the single-product function (single-product becomes a thin
wrapper so there is still exactly one formula). `SECURITY DEFINER`, business-access
check, `authenticated` + `service_role` grants, `anon` revoked.

**7b. Repoint the server list RPC.**
Rewrite `list_products_with_branch_stock` so `on_hand / reserved / available` come
from the batch engine instead of `warehouse_stock` arithmetic; drop the dead 3-arg
overload. No signature change for callers.

**7c. Repoint the browser.**
`resolveAvailabilityFor` calls the batch RPC once. Migrate the eight allowlisted
files to it (or to the already-correct RPC columns) and empty PENDING_MIGRATION.
Display-only "reserved" chips may keep reading the `warehouse_stock` read model;
any number that drives a decision goes through the engine.

**7d. Replenishment.**
`computeRecommendation` keeps pure rounding/urgency helpers, but the availability
input must arrive from the engine, not be derived in the browser. If a server-side
replenishment recommender already exists, use it; do not build a second one.

**7e. Ratchet.**
Extend `availability-is-server-owned.test.ts` (empty allowlist) and add a SQL
ratchet asserting no `public` function other than the engine derives
`quantity - reserved_quantity` for availability.

## Phase 8 — documentation + behavioural sweep

- ADR 0142 addendum for the batch engine; ADR addendum for Phase 5 expiry policy
  and the Phase 6 event fabric; refresh the operator guide.
- Run and read in full: `inventory_movement_ledger_test.sql`,
  `inventory_valuation_guard_test.sql`, `inventory_lot_serial_traceability_test.sql`,
  `inventory_event_fabric_test.sql`, `inventory_reservation_engine_test.sql`,
  plus `check_movement_reversal_coverage()`, `check_stock_quant_drift(NULL)`,
  `check_valuation_writer_coverage()`, `check_inventory_valuation_drift(NULL,0.01)`,
  `check_serial_position_drift(NULL)`.
- Behavioural proof (the outstanding gap): receive stock through the UI, then
  confirm one movement → one quant row → one `inventory.movement.recorded` outbox
  row with `handler_scope='server'`, drained by `outbox-dispatcher`, and one
  cost layer with the expected AVCO.

## Rules of engagement (unchanged)

Migrations only through the migration tool; new functions `authenticated` +
`service_role`, `anon` revoked; reuse canonical engines (`convert_uom`,
`resolve_product_identity`, `emit_inventory_event`, `resolve_exchange_rate`,
`cost_layers`) — no duplicates; no business logic in the browser; finish a phase
before starting the next.
