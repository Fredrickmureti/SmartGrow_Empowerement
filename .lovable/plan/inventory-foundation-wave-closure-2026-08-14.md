# Inventory Foundation Wave — CLOSED (2026-08-14)

**Reference architecture:** ADR 0142 (single balance / availability / reservation),
ADR 0078 (AVCO canonical), ADR 0076 (stock event fabric), ADR 0064, ADR 0025.

## Final status

| Phase | Scope | State |
|---|---|---|
| 1 | Single balance store + single availability engine | CLOSED |
| 1b | `get_available_pos_stock_for_register` on the engine | CLOSED |
| 2 | Single reservation engine + lifecycle | CLOSED |
| 3 | Movement ledger completeness | CLOSED |
| 4 | Costing & valuation guard (AVCO canonical) | CLOSED |
| 5 | Lots / serials / expiry traceability | CLOSED |
| 6 | Business events — one emitter, complete topics | CLOSED (defect found + fixed in Phase 8) |
| 7 | Availability repoint — batch engine, server RPCs, browser, planner | CLOSED |
| 8 | Documentation + behavioural sweep | CLOSED |

## Phase 8 — what was proven, not just asserted

**8a. Behavioural proof against live data** (business `bf392ca6…`, HQ warehouse):

- Receipt leg (+100 @ 50) and issue leg (−40 @ 50) through
  `apply_or_request_stock_adjustment`.
- Result chain verified end to end:
  2 `stock_movements` → 1 `stock_quants` row at 60 → `warehouse_stock` 60 @ AVCO 50
  → 1 `cost_layers` row (100 total / 60 remaining @ 50)
  → 1 `cost_layer_consumptions` row (40 @ 50)
  → 2 `inventory.movement.recorded` outbox rows, `handler_scope='server'`,
    drained by `outbox-dispatcher` to `succeeded`
  → 2 posted journal entries (JE-00002 5,000 / JE-00003 2,000, balanced).

**Defect found and fixed (Phase 6 completeness gap).**
Six emitted topics had no `business_event_topics` row:
`stock.adjustment.posted`, `stock.transfer.approved`, `stock.transfer.completed`,
`stock.count.completed`, `stock.count.cancelled`,
`inventory.physical_count.posted`, `inventory.reorder.recompute`.
`pos_topic_handler_scope()` defaults unknown topics to `'server'`, so host-scoped
rows were claimed by the server dispatcher and dead-lettered as
`unknown_event_type`. All are now registered with the scope that matches their
real handler (5 host / 2 server), the two server-scoped ones are registered in
the `outbox-dispatcher` HANDLERS map, and the dead-lettered row was re-queued.

**8b. Guard sweep** — all six SQL ratchets executed against the live database
*with data present*, all pass:
`inventory_movement_ledger_test`, `inventory_valuation_guard_test`,
`inventory_availability_single_formula_test`, `inventory_reservation_engine_test`,
`inventory_lot_serial_traceability_test`, `inventory_event_fabric_test`.
Drift/coverage reports all return zero rows:
`check_movement_reversal_coverage()`, `check_stock_quant_drift(NULL)`,
`check_valuation_writer_coverage()`, `check_inventory_valuation_drift(NULL,0.01)`,
`check_serial_position_drift(NULL)`.

**8c. Last exemption retired.**
`resolve_stock_availability_batch` gained `p_location_ids uuid[]` (bin grain);
`_wms_maybe_enqueue_replen` now calls the engine instead of deriving
`quantity - reserved_quantity`. The availability ratchet allowlist is **empty**.

**8d. Documentation.** ADR 0142 addendum (location grain, empty allowlist) and
ADR 0076 addendum (topic registration is mandatory, scope must match the handler).

**8e. Ratchets added this phase.**
- `inventory_event_fabric_test.sql` §6 — every emitted `stock.*` / `inventory.*`
  topic literal must be registered in `business_event_topics`.
- `inventory_availability_single_formula_test.sql` — empty allowlist.

## Invariants the next wave inherits

1. One balance store (`stock_quants`), one availability formula
   (`resolve_stock_availability_batch`), one reservation engine
   (`reserve_stock_atomic` + lifecycle), one valuation engine (AVCO).
2. Availability is server-owned; the browser never derives it.
3. Every stock movement carries provenance and emits exactly one inventory event
   through `emit_inventory_event`; every topic is registered with the correct
   `handler_scope`.
4. Migrations only through the migration tool; new functions are
   `SECURITY DEFINER` with a business-access check, `authenticated` +
   `service_role` granted, `anon` revoked.
