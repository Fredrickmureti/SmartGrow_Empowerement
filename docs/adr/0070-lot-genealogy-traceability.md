# ADR 0070 — Lot Genealogy & Traceability View

**Status:** Accepted
**Phase:** G (Inventory Foundation Audit)
**Supersedes:** —
**Related:** ADR 0025 (lot-tracked movements), ADR 0064 (locations/quants), ADR 0066 (downstream lot-serial stamping), ADR 0067 (serialised inventory), ADR 0069 (ASN inbound-shipments).

## Context

The Inventory Foundation Audit graded **Inventory Traceability** as
architecturally sound at the persistence layer — every outbound
`stock_movement` carries the `lot_number` / `serial_number` stamped by
the downstream pickers, and `stock_lots` is populated on GRN — but
operators had no way to see it. A regulator asking "where did lot
`LOT-2411-A` end up?" required raw SQL. That is not enterprise
traceability; it is data that happens to exist.

## Decision

Ship a read-only, business-scoped Lot Genealogy surface backed by
existing tables. No schema changes, no RPCs, no new writes.

1. **`/inventory-app/lots`** — index of `stock_lots` for the active
   business, filterable by product, expiry window, and supplier.
2. **`/inventory-app/lots/:id`** — single lot page composed of three
   sections all derived from `stock_movements` filtered by
   `product_id = lot.product_id AND lot_number = lot.lot_number` in
   the active business:
   - **Origin** — `stock_lots` row + linked `goods_receipt` + supplier.
   - **On-hand distribution** — per-warehouse net (in − out) computed
     from `stock_movements` grouped by `warehouse_id`.
   - **Timeline** — every movement in chronological order, each row
     resolving `reference_type` / `reference_id` to a human link
     (GRN, invoice, credit note, delivery note, transfer, scrap,
     adjustment, sales return, POS).
3. **Nav entry** — sidebar link under Inventory → Operations → Lots.
4. **Architecture guard** `lot-genealogy-ui.test.ts` pins:
   - Routes registered.
   - Detail page reads `stock_lots` **and** `stock_movements` scoped
     by `business_id` + `product_id` + `lot_number`.
   - Timeline query orders by `movement_date`.
   - Nav exposes the surface.

## Non-goals (deferred)

- Forward genealogy graph (lot → child lots via manufacturing).
  Deferred until BOM / manufacturing lands. `stock_lots` has no
  `parent_lot_id` today by design.
- Serial-number genealogy view. `stock_serials` already exposes
  status transitions; a companion `/serials/:id` page ships in a
  later turn.
- CSV / PDF export of genealogy report. Add-on, not blocking.

## Consequences

- Regulator / recall workflow: from lot number, one click reveals
  every customer shipment carrying that lot.
- Zero write path — cannot corrupt inventory state.
- The guard pins the query shape, so a future refactor that drops
  the `lot_number` filter (silently widening the timeline to the
  whole product) fails CI, not audit.
