# ADR 0142 — One balance store, one availability engine, one reservation engine

**Status:** Accepted (2026-08-14)
**Related:** 0064 (locations/quants), 0025 (lot quants), 0078 (AVCO), 0079 (Inventory vs Warehouse)

## Context

The Inventory foundation audit found three heads on one engine:

- **Two balance stores.** `stock_quants` (location grain, ADR 0064) and
  `warehouse_stock` (warehouse grain) were each maintained independently from
  `stock_movements`. Every decision-making consumer read `warehouse_stock`;
  quants were effectively unused.
- **Three availability formulas.** `get_available_stock`,
  `get_available_pos_stock`, `get_available_pos_stock_for_register`, plus
  `quantity - reserved_quantity` recomputed in ~10 React surfaces.
- **Four reservation paths.** `reserve_stock` (counter only, no audit row),
  `create_stock_reservation` (counter + row), `reserve_pos_stock`,
  `_wms_replen_reserve`.

`_maintain_stock_quants` also failed open: a movement into a warehouse with no
default location returned silently, dropping the quantity from the quant ledger.

## Decision

1. **`stock_quants` is the only maintained balance.** `warehouse_stock.quantity`
   and `.reserved_quantity`, `products.stock_quantity` and
   `warehouse_stock_lots` are derived projections. `warehouse_stock` keeps its
   own writable configuration columns (reorder levels, `average_cost`,
   `bin_location`, `last_counted_at`).
2. **Quant maintenance fails closed.** A movement whose warehouse has no
   default location raises instead of silently skipping.
3. **`resolve_stock_availability` is the only availability authority.** The
   legacy functions become wrappers over it. Availability excludes transit,
   quarantine and blocked locations and subtracts open reservation rows.
4. **Reserved quantity is derived from `stock_reservations`.** No path may
   increment a reserved counter without an accompanying reservation row.
5. The browser may not compute availability. An architecture test enforces it.

## Consequences

- Location-aware state (transit, quarantine, blocked) becomes visible to every
  consumer without each one reinventing a filter.
- POS, Sales and WMS converge on one number; register-scoped POS behaviour
  becomes a parameter of the canonical engine, not a separate formula.
- `warehouse_stock` stays as the fast warehouse-level read model, so existing
  reads keep working while the truth moves underneath them.

## Addendum — reservation engine (Phase 2, 2026-08-14)

`stock_reservations` carries the lifecycle (`reserved → allocated → consumed |
released | expired`), consumed and original quantities, optional bin location and
lot, a per-organisation idempotency key, a release reason and metadata.

`reserve_stock_atomic` is the **only** writer of reservation rows. Allocation,
consumption, release and expiry each have exactly one function, and
`consume_/release_stock_reservations_for_source` serve the document-level cases
(sales order, POS register, pick wave, replenishment order, physical count).

`reserve_stock`, `create_stock_reservation`, `release_stock` and
`release_reserved_stock` are dropped. Reserved quantity is a projection at both
grains — warehouse (`refresh_warehouse_stock_projection`) and bin
(`refresh_quant_reserved_projection`) — and `trg_guard_quant_reserved` rejects any
hand-written change to `stock_quants.reserved_quantity`.

Ratchet: `supabase/tests/inventory_reservation_engine_test.sql`.
