# ADR 0068 — Split Stock Transfers (Directional Movement Types)

**Status:** Accepted (2026-07-16)
**Depends on:** ADR 0064 (stock locations & quants), ADR 0065 (transit & quarantine locations)

## Context

Stock transfers between warehouses were already two-legged at the RPC
level: `approve_stock_transfer_atomic` moves goods from the source
warehouse into an "in-transit warehouse", and
`complete_stock_transfer_atomic` moves them from in-transit into the
destination warehouse. Both legs, however, wrote `movement_type =
'transfer'` with direction carried only in `sign(quantity)`, and neither
leg populated the Phase-2 `source_location_id` / `destination_location_id`
columns on `stock_movements`.

Consequences of the pre-split state:

- Analytic views already discriminate `'transfer_in'` vs `'transfer_out'`
  (see the on-hand rebuild views shipped 2026-07-08 through 2026-07-09),
  so the RPCs were producing rows those views could not classify without
  falling back to `sign(quantity)`.
- The `stock_quants` shadow (ADR 0064 Phase 2) fell back to
  "warehouse default location" for the in-transit leg because
  `source_location_id` / `destination_location_id` were both NULL. This
  routed transit quantities to the physical *in-transit warehouse*'s
  default location instead of the **business-scoped virtual transit
  location** seeded by Phase 4 (ADR 0065).
- Recall / traceability queries against `stock_movements` had to inspect
  sign to know whether a transit event was a dispatch or a receipt.

## Decision

Both transfer RPCs are rewritten so every emitted movement carries:

1. A **directional `movement_type`**:
   - `'transfer_out'` on every negative-quantity leg (dispatch out of
     source, receive-out-of-transit).
   - `'transfer_in'` on every positive-quantity leg (into transit, into
     destination).
2. **Location provenance** stamped explicitly. The `warehouse_id`
   column remains NOT NULL and continues to reference the physical
   warehouse involved in the leg (source, in-transit, or destination).
   In addition:
   - Source-warehouse dispatch (−N): `source_location_id` = source
     warehouse's default location; `destination_location_id` = NULL.
   - Into transit (+N): `source_location_id` = NULL;
     `destination_location_id` = **business transit location**
     (`get_business_transit_location(business_id)`), i.e. the Phase-4
     virtual location, not the in-transit warehouse's default location.
   - Out of transit (−N): `source_location_id` = business transit
     location; `destination_location_id` = NULL.
   - Destination receipt (+N): `source_location_id` = NULL;
     `destination_location_id` = destination warehouse's default
     location.

This preserves the four-insert double-entry shape (which the
`warehouse_stock` legacy trigger depends on) while giving the
`stock_quants` shadow the correct location deltas — in-transit stock now
accumulates on the business virtual transit location, matching the
Phase 4 canonical model.

## Backward compatibility

- Historical rows with `movement_type = 'transfer'` are left untouched.
  Every consumer that classifies movements (`_maintain_warehouse_stock_lots`,
  `rebuild_warehouse_stock_lots`, the on-hand views) already treats
  legacy `'transfer'` as a sign-based fallback, so old data continues to
  reconcile.
- `warehouse_stock` remains authoritative until the Phase 5 drift gate
  (ADR 0064) is met. No changes to its triggers.
- No new tables. No changes to `stock_movements`, `stock_locations`, or
  `stock_quants` shapes. Migration is RPC-only.

## Enforcement

- `src/test/architecture/split-transfer.test.ts` pins the migration SQL:
  `approve_stock_transfer_atomic` and `complete_stock_transfer_atomic`
  must emit `'transfer_out'` and `'transfer_in'`, must never emit the
  legacy `'transfer'` token, and must call
  `get_business_transit_location(...)` for the transit leg.

## Consequences

- Recall/audit queries can now answer "outbound vs inbound transit event"
  directly from `movement_type`.
- `v_stock_on_hand` (Phase 3) filters transit correctly because the
  transit leg now stamps the canonical business transit location.
- The virtual business transit location becomes the single ledger anchor
  for in-transit inventory across the whole platform; future consumers
  (WMS, financial in-transit valuation) read it uniformly.

## Out of scope

- Retiring the physical in-transit warehouse (`get_or_create_in_transit_warehouse`).
  It stays as the `warehouse_id` anchor for the transit-leg movements
  until Phase 5 lets us drop `warehouse_stock` and its NOT NULL
  requirement on `stock_movements.warehouse_id`.
- Serial-per-leg identity for transfer moves (already handled by ADR 0067
  triggers on `stock_movements`; no change required here).
