# Inventory Foundation Wave — authoritative status

**Reference architecture:** ADR 0142 (single balance / availability / reservation),
ADR 0078 (AVCO canonical), ADR 0076 (stock event fabric), ADR 0064, ADR 0025.
**Ledgers:** `.lovable/plan/inventory-foundation-wave-execution-ledger-2026-08-14.md`
**Last updated:** 2026-08-14 (Phase 6 session)

## Status ledger

| Phase | Scope | State |
|---|---|---|
| 1 | Single balance store + single availability engine | VERIFIED |
| 1b | `get_available_pos_stock_for_register` on the engine | VERIFIED |
| 2 | Single reservation engine + lifecycle | VERIFIED |
| 3 | Movement ledger completeness | VERIFIED |
| 4 | Costing & valuation guard (AVCO canonical) | VERIFIED |
| 5 | Lots / serials / expiry traceability closure | COMPLETE (structural pass) |
| 6 | Business events — one emitter, complete topics | **COMPLETE this session (structural pass)** |
| 7 | UI repoint — clear the allowlisted files computing inventory truth in the browser | **ACTIVE NEXT** |
| 8 | Documentation + operator guide refresh | NOT STARTED |

## Phase 6 — what landed (verified)

Defects found and fixed (all real, all confirmed against the live database):

1. **Two competing emitters.** `tg_stock_movement_emit_event` (full coverage) existed
   but was **not attached to any trigger**; the only attached emitter,
   `trg_stock_movement_emit_event_fn`, filtered to `pos_sale` / `pos_return`.
   Every non-POS movement — receipts, transfers, adjustments, scrap, counts,
   landed cost, opening balances — emitted **nothing**.
2. **Wrong routing.** `business_event_outbox.handler_scope` defaults to `'host'`
   and neither emitter set it, so `inventory.movement.recorded` rows were never
   claimable by the server `outbox-dispatcher` (it claims `handler_scope='server'`).
   Reorder recompute was effectively dead.
3. **No lot / serial / valuation events at all**, contrary to the Phase 6 contract.

Implemented:

- `inventory_movement_event_classes` — registry mapping all 15 allowed
  `movement_type` values to a business class (received / dispatched /
  transferred / adjusted / posted). RLS on, `authenticated` read, `anon` revoked.
- `emit_inventory_event(...)` — **the single seam** by which Inventory writes
  `business_event_outbox`. Resolves `handler_scope` from `business_event_topics`
  and fails closed (`INVENTORY_UNREGISTERED_EVENT_TOPIC`) on unregistered topics.
- `tg_stock_movement_emit_event` rewritten: registry-driven, fails closed
  (`INVENTORY_UNMAPPED_MOVEMENT_TOPIC`), emits one
  `inventory.movement.recorded` per movement with `movement_class` and
  `signed_quantity` (via the Phase 5 direction authority) in the payload.
  Idempotency key `inventory.movement.recorded:<movement_id>`.
- Legacy POS-only emitter trigger and function **dropped**.
- New lifecycle emitters: `trg_lot_quarantine_emit_event`,
  `trg_product_recall_emit_event`, `trg_stock_serial_emit_event`,
  `trg_inventory_revaluation_emit_event` → topics
  `inventory.lot.quarantined|released|recall_opened|recall_closed`,
  `inventory.serial.status_changed`,
  `inventory.valuation.revalued|revaluation_reversed`. All registered in
  `business_event_topics` with `handler_scope='server'`.
- `outbox-dispatcher`: all eight inventory topics registered (movement →
  reorder recompute; lifecycle → explicit recorded-noop so the closed registry
  cannot dead-letter them).
- Client: `DomainEventType` retires the five `stock.movement.*` topics for the
  canonical `inventory.*` family; `BusinessSagaMount` registers one host-side
  observer on `inventory.movement.recorded` (observation only — no inventory
  truth in the browser).
- Ratchets: `supabase/tests/inventory_event_fabric_test.sql` (single emitter,
  registry coverage of every `movement_type`, fail-closed codes, server scope,
  four lifecycle triggers) and the rewritten
  `src/test/architecture/stock-event-fabric-and-landed-cost.test.ts`.

Verification run this session:
- `npx tsgo --noEmit` → clean.
- `bunx vitest run src/test/architecture/stock-event-fabric-and-landed-cost.test.ts`
  → 10/10 pass.
- Live DB assertions: direct outbox-writing triggers on `stock_movements` = 0,
  `tg_stock_movement_emit_event` triggers = 1, legacy function = 0, registry
  rows = 15, server-scoped `inventory.*` topics = 8, lifecycle triggers = 4.

**Known limitation (carry forward):** the tenant database still holds zero
`stock_movements`, so Phase 6 is a *structural* pass. No event has yet been
observed end-to-end through `emit_inventory_event → outbox → dispatcher`.
Phase 8 must include one behavioural run.

## Phase 7 — UI repoint (next)

Clear the surfaces that still compute inventory truth in the browser
(`quantity - reserved_quantity` and similar) and route them through the single
availability engine from Phase 1. Known allowlisted files:
`Inventory.tsx`, `Forecast.tsx`, `ProductStockPanel`, `StockTab`, `OverviewTab`,
`WarehouseStockPeekSheet`, `LicensePlateView`, `readOnHand`.
Deliverable: an architecture test forbidding local availability arithmetic, so
the allowlist cannot regrow.

## Phase 8 — Documentation + behavioural sweep

- ADR addendum for the expiry policy (Phase 5), the genealogy projection and
  the Phase 6 event fabric; refresh the operator guide.
- Run, and read in full: `supabase/tests/inventory_movement_ledger_test.sql`,
  `inventory_valuation_guard_test.sql`,
  `inventory_lot_serial_traceability_test.sql`,
  `inventory_event_fabric_test.sql`, plus
  `check_movement_reversal_coverage()`, `check_stock_quant_drift(NULL)`,
  `check_valuation_writer_coverage()`,
  `check_inventory_valuation_drift(NULL, 0.01)`,
  `check_serial_position_drift(NULL)`.
- Behavioural proof: create one real movement in the UI and confirm exactly one
  `inventory.movement.recorded` row appears with `handler_scope='server'` and is
  drained by `outbox-dispatcher`.

## Instructions for the next agent

1. **Verify before building.** Re-check the Phase 6 claims above directly against
   the database and the code, not against this file: confirm there is exactly one
   emitter trigger on `stock_movements`, that no other trigger writes
   `business_event_outbox` directly, that `handler_scope` resolves to `server`,
   and that every `movement_type` in the check constraint has a registry row.
   `supabase/tests/inventory_event_fabric_test.sql` does all of this in one run.
2. **Then resume at Phase 7 (UI repoint)** — not unrelated work, not a new audit.
3. **Rules of engagement:** migrations only through the migration tool; new
   functions `authenticated` + `service_role`, `anon` revoked; reuse existing
   engines (`convert_uom`, `resolve_product_identity`, `publish_business_event` /
   `emit_inventory_event`, `resolve_exchange_rate`, `cost_layers`) — no duplicates;
   no business logic in the browser; master data stays separate from transactional
   state; finish a phase before starting the next.
