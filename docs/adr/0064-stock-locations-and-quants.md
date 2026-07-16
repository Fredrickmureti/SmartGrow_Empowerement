# ADR 0064 — Stock locations and per-location quants

**Status:** Accepted (2026-07-16)
**Supersedes/extends:** ADR 0025 (lot-aware quants and FEFO)
**Related:** inventory-verdict.md, ADR 0016 (adjustment GL integrity)

## Context

The audit at `.lovable/plan.md` identified the single biggest structural
gap in the inventory foundation: stock is tracked at
`(product, warehouse, lot)` only. Every enterprise WMS models the stock
identity as `(product, location, lot, package, owner)` — a **quant**.

Without a location dimension:

- WMS features are impossible: putaway, pick paths, replenishment waves,
  bin-level cycle counts, 3PL directives.
- Quarantine, damaged, staging, and in-transit stock have nowhere to
  live except a fake "warehouse". Today `lot_quarantine` is a floating
  table with no location state.
- Split transfer (issue → in-transit → receive) cannot be expressed;
  today the `transfer` movement is atomic and in-transit stock is
  implicit.
- Quality inspection between GRN and available stock cannot be modelled.

## Decision

Introduce two new tables **additively**:

### `stock_locations`

Hierarchical location tree inside a warehouse. Every warehouse gets one
implicit `default` location on migration so existing behaviour is
preserved.

```
stock_locations
  id
  warehouse_id            -> warehouses.id
  parent_location_id      -> stock_locations.id (self-fk, nullable)
  organization_id, business_id, branch_id  (scope inherited from warehouse)
  code                    text  -- unique within warehouse
  name                    text
  location_type           enum: 'internal' | 'quarantine' | 'staging'
                                 | 'transit' | 'customer' | 'vendor'
                                 | 'scrap' | 'production' | 'view'
  usage                   enum: 'storage' | 'pick' | 'pack' | 'ship'
                                 | 'receive' | 'inspection' | 'virtual'
  is_active               bool default true
  is_default              bool -- exactly one per warehouse
```

Additional virtual locations exist per business (not per warehouse) for
`customer`, `vendor`, `scrap`, `production` — these are the counter-parts
that make every movement a location-to-location transfer (Odoo double-
entry inventory model).

### `stock_quants`

Per-location, per-lot on-hand balance. This is the new source of truth
once consumers migrate. Phase 1 keeps `warehouse_stock` and
`warehouse_stock_lots` in sync via triggers.

```
stock_quants
  id
  product_id              -> products.id
  location_id             -> stock_locations.id
  lot_number              text nullable
  quantity                numeric  -- signed, base UoM
  reserved_quantity       numeric default 0
  package_id              -> product_packaging.id nullable  -- reserved
  owner_id                uuid nullable                     -- reserved for 3PL
  organization_id, business_id, branch_id
  updated_at
  UNIQUE (product_id, location_id, lot_number, package_id, owner_id)
```

### Backfill and sync (Phase 1 only)

1. On migration, for every warehouse create one `stock_locations` row
   `{ is_default: true, location_type: 'internal', usage: 'storage' }`.
2. Backfill `stock_quants` from `warehouse_stock_lots` and
   `warehouse_stock` (product-level rows for non-lot-tracked products
   get `lot_number = NULL`).
3. Install `_maintain_stock_quants` AFTER-INSERT trigger on
   `stock_movements`. For now the trigger routes every movement into the
   warehouse's `is_default` location so quants stay coherent without
   any consumer change.
4. Keep existing `_maintain_warehouse_stock` /
   `_maintain_warehouse_stock_lots` triggers running. `stock_quants`
   is a shadow ledger until Phase 2.

### Later phases (not in this PR)

- **Phase 2**: writers (GRN, transfer, adjustment, sale, POS) start
  stamping `source_location_id` / `destination_location_id` on
  `stock_movements`. Trigger prefers stamped location over the default.
- **Phase 3**: readers (`useInventory`, replenishment, valuation) query
  `stock_quants` instead of `warehouse_stock`. `warehouse_stock` becomes
  a derived view.
- **Phase 4**: `warehouse_stock` retired. Transfer becomes
  `transfer_out` (→ transit location) + `transfer_in` (transit →
  destination). Quarantine wires to `lot_quarantine`.
- **Phase 5**: bin-level cycle counts, putaway rules, pick strategies.

## Invariants

- Every `stock_quants` row belongs to exactly one location; scope is
  inherited from the warehouse. RLS mirrors `warehouse_stock`.
- A location cannot be deleted while any `stock_quants` row references
  it. `is_active = false` is the soft-retire path.
- Non-internal locations (`transit`, `customer`, `vendor`, `scrap`,
  `production`) may hold negative quants (they are counter-party
  buckets in the double-entry inventory model). Internal locations
  cannot (guarded by trigger — Phase 2).
- `warehouse_stock` remains authoritative during Phase 1 to avoid
  invalidating any RPC in the platform.

## Consequences

- Zero regression risk in Phase 1 because no reader or writer changes.
- Unblocks WMS, QC, split transfer, quarantine state machine.
- Requires a follow-up migration per phase; each is a separate ADR.
