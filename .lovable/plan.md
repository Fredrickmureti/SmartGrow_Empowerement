# Inventory Foundation Wave — authoritative status

**Reference architecture:** `docs/adr/0142-inventory-single-balance-availability-reservation.md`
**Domain map:** `docs/audit/inventory-domain-map.md`
**Last updated:** 2026-08-14 13:00 UTC

## Status at a glance

| Phase | Scope | State |
|---|---|---|
| 1 | Single balance store + single availability engine | ✅ Complete, verified in live DB |
| 2 | Single reservation engine + lifecycle | ✅ Complete, verified in live DB |
| **3** | **Movement ledger completeness (reversal parity, revaluation, provenance, drift)** | **▶ ACTIVE — not started** |
| 4 | Costing & valuation guard (AVCO canonical) | ⏳ Pending |
| 5 | Lots / serials / expiry traceability closure | ⏳ Pending |
| 6 | Business events: one emitter, complete topics | ⏳ Pending |
| 7 | UI repoint (clear the 8 allowlisted files) | ⏳ Pending |
| 8 | Documentation + operator guide refresh | ⏳ Pending |

**Next task to pick up:** Phase 3, item 1 — reversal parity for every
movement-producing RPC.

---


## Phase 1 — One balance, one availability engine — COMPLETE (verified)

- `stock_quants` is the only maintained balance. `_maintain_stock_quants` now
  **fails closed** when a warehouse has no default location.
- `warehouse_stock.quantity` / `.reserved_quantity` and
  `products.stock_quantity` are derived projections
  (`refresh_warehouse_stock_projection`, `trg_project_warehouse_stock`,
  `trg_project_warehouse_stock_reservations`). Configuration columns
  (reorder levels, `average_cost`, `bin_location`) stay writable.
- `resolve_stock_availability(product, business, branch, warehouse)` is the only
  availability authority; `get_available_stock` and `get_available_pos_stock*`
  are thin wrappers.
- Client seam: `src/lib/inventory/availability.ts` (`resolveAvailability`).
- Guard: `src/test/architecture/availability-is-server-owned.test.ts`
  (8 legacy files remain on the `PENDING_MIGRATION` allowlist → Phase 7).

## Phase 2 — One reservation engine — COMPLETE (verified)

Lifecycle on `stock_reservations`: `reserved → allocated → consumed | released | expired`,
plus `quantity_consumed`, `original_quantity`, `location_id`, `lot_number`,
`idempotency_key` (unique per org), `release_reason`, `metadata`, `consumed_at`,
`updated_at`. `trg_stock_reservations_sync_state` keeps `status` and the legacy
`released_at` in lockstep.

Canonical engine (only writer of reservation rows):

| Function | Role |
|---|---|
| `reserve_stock_atomic` | create a hold; quant-level `FOR UPDATE`, availability from `resolve_stock_availability` (or bin-grain when `location_id` given), idempotency replay, optional partial fill |
| `allocate_stock_reservation` | reserved → allocated |
| `consume_stock_reservation` / `consume_stock_reservations_for_source` | partial or FIFO consumption |
| `release_stock_reservation` / `release_stock_reservations_for_source` | release with a reason |
| `expire_stock_reservations` | lifecycle-based expiry sweep |

Removed duplicates: `reserve_stock`, `create_stock_reservation`,
`release_stock`, `release_reserved_stock` (no callers).

Repointed onto the engine: `confirm_sales_order_atomic` (idempotent per SO line),
`consume_so_reservation`, `restore_so_reservation` (previously referenced a
non-existent `metadata` column — now fixed and lifecycle-aware),
`_wms_consume_order_reservation`, `release_sales_order_reservations_atomic`,
`reserve_pos_stock` / `release_pos_stock_reservation`, `_wms_replen_reserve`,
`_wms_replen_release`, `release_pick_wave`, `_wms_unwind_cancelled_wave`
(now restores the SO hold instead of inserting a duplicate),
`physical_count_freeze_scoped`, `_release_physical_count_reservations`.

Reserved quantity is now derived everywhere:
- `warehouse_stock.reserved_quantity` ← open reservation rows.
- `stock_quants.reserved_quantity` ← `refresh_quant_reserved_projection`, and
  `trg_guard_quant_reserved` **rejects** any hand-written change.

Verification run this turn: 0 rogue reservation writers, 9/9 lifecycle columns,
3/3 triggers present, 4/4 duplicate engines gone.
Ratchet: `supabase/tests/inventory_reservation_engine_test.sql`.

---

## Phase 3 — Movement ledger completeness — NEXT

1. Reversal parity: every movement-producing RPC has a reversal that writes a
   compensating movement (never a delete/update).
2. Value-only revaluation movements (landed cost, WAC correction) must not move
   quantity.
3. Movement provenance: `source_type`/`source_id` mandatory and validated.
4. Drift RPC comparing `stock_quants` vs `warehouse_stock` vs
   `products.stock_quantity`, exposed as an integrity report.

## Phase 4 — Costing & valuation guard
AVCO canonical per ADR 0078; `cost_layers` = lot detail only; guard test.

## Phase 5 — Lots, serials, expiry traceability closure.

## Phase 6 — Business events: one emitter, complete movement/reservation topics.

## Phase 7 — UI repoint
Clear the 8 `PENDING_MIGRATION` files in
`src/test/architecture/availability-is-server-owned.test.ts`; all decision-making
reads go through `resolveAvailability`.

## Phase 8 — Documentation + operator guide refresh.

---

## Instructions for the next agent

1. **Verify Phase 2 before writing anything.** Confirm in the live database:
   `reserve_stock_atomic` is the only function containing
   `INSERT INTO public.stock_reservations`; `reserve_stock`,
   `create_stock_reservation`, `release_stock`, `release_reserved_stock` do not
   exist; the three triggers above exist; and
   `supabase/tests/inventory_reservation_engine_test.sql` passes.
2. Only then start **Phase 3**, item 1 (reversal parity). Do not jump phases and
   do not leave a phase half-done.
3. Update this file at the end of every implementation step.
