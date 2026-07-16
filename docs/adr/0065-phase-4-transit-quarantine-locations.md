# ADR 0065 — Phase 4: transit locations, quarantine wiring, split transfer

**Status:** Accepted (2026-07-16)
**Extends:** ADR 0064 (stock locations & quants)
**Related:** ADR 0025 (lot-aware quants), lot_quarantine table

## Context

ADR 0064 delivered the location dimension and the quants shadow ledger
(Phase 1), stamped `source_location_id` / `destination_location_id` on
movements (Phase 2), and shipped read views (`v_stock_on_hand`,
`v_warehouse_stock_effective`, `v_location_summary`) plus the drift
helper (Phase 3). Three gaps remain before the inventory backbone can
carry WMS / QC / 3PL semantics:

1. **In-transit stock is invisible.** A `transfer` movement is atomic —
   the moment `warehouse_stock` decrements at the source and increments
   at the destination happens in the same row. There is no window
   during which the stock is "on a truck." A carrier discrepancy, a
   damage claim, or a delayed goods-in scan has nowhere to live.
2. **Quarantine has no stock effect.** `lot_quarantine` sets a status
   flag but the quarantined units still count as available in
   `warehouse_stock` / `stock_quants`. QC hold is documentation, not
   enforcement.
3. **`warehouse_stock` retirement.** Every reader still hits the legacy
   aggregate. Cutover must be gated on drift = 0.

## Decision

### 1. Virtual + physical location seeding

For every business, ensure exactly one **virtual transit location** per
business (`location_type = 'transit'`, `usage = 'virtual'`, no
`warehouse_id`). Transit is a counter-party bucket in the Odoo double-
entry model: `transfer_out` decrements source storage and increments
transit; `transfer_in` decrements transit and increments destination
storage. Net effect on total on-hand across the business is zero at
each step, and open transits are queryable as `SELECT * FROM
v_stock_on_hand WHERE location_type = 'transit'`.

For every warehouse, ensure exactly one **quarantine location**
(`location_type = 'quarantine'`, `usage = 'inspection'`,
`is_default = false`). Quarantine sits inside the warehouse (units are
physically there) but is excluded from available-to-promise reads.

Both are additive on migration. `stock_locations` gains a check
allowing `warehouse_id IS NULL` when `location_type = 'transit'`
(business-scoped virtual location).

### 2. `lot_quarantine` trigger wiring

AFTER INSERT / UPDATE on `lot_quarantine`:

- On `status = 'quarantined'` (new hold): emit a `quarantine_hold`
  movement that debits the warehouse's default storage location and
  credits its quarantine location for the full on-hand quantity of the
  affected `(product, warehouse, lot_number)`.
- On transition to `status = 'released'`: emit `quarantine_release`
  (inverse).
- Discard-path (`status = 'scrapped'`) is handled by the existing
  scrap flow; the trigger only ensures quants leave the quarantine
  bucket.

The `stock_quants` maintenance trigger (Phase 2) already handles the
double-entry when both locations are stamped, so no new quant logic is
needed — only the movement emitter.

### 3. Split-transfer convention

`stock_movements.movement_type` is `text`, so no enum migration is
required. Introduce two new values used side-by-side with the existing
atomic `transfer`:

- `transfer_out` — source_location → business transit location.
- `transfer_in`  — business transit location → destination_location.

`stock_transfers.status` transitions drive emission:

- `in_transit`  → emit `transfer_out` for every item, once.
- `completed`   → emit `transfer_in` for every item, once.

Existing atomic `transfer` movements remain valid for backwards
compatibility — the trigger tolerates both. Callers migrate at their
own pace. `useWarehouses` transfer completion path is the first
adopter (separate PR).

### 4. Retirement gate for `warehouse_stock`

Not executed in this ADR. Cutover requires 14 consecutive days of
`SELECT * FROM check_stock_quant_drift(business_id)` returning empty
across all production businesses. When met, a Phase 5 migration will:

1. Drop the `_maintain_warehouse_stock` trigger.
2. Rename `warehouse_stock` → `warehouse_stock_deprecated_YYYYMMDD`.
3. Replace with a view `warehouse_stock` derived from `stock_quants`.
4. Delete the deprecated table after one more clean week.

Readers still targeting `warehouse_stock` continue to work because the
view preserves the column shape. New readers should use
`v_stock_on_hand`.

## Invariants

- Exactly one transit location per business (unique partial index).
- Exactly one quarantine location per warehouse (unique partial index).
- Transit locations may hold negative quants (open transits with
  discrepancies are visible as non-zero balances).
- Quarantine locations may not go negative (guarded by trigger in a
  later PR — noise-free for now because releases only match holds).
- A `lot_quarantine` row with `status='quarantined'` implies a
  non-empty quant in the paired quarantine location for its
  `(product, warehouse, lot_number)`.

## Consequences

- QC hold now enforces stock unavailability at the ledger level, not
  only at the UI.
- Split transfer unblocks carrier-level tracking, damage in transit,
  and receive-with-discrepancy workflows.
- Zero reader regression: `warehouse_stock` remains authoritative
  until the retirement gate is met.
- Every remaining WMS feature (putaway rules, pick paths, bin cycle
  counts) becomes a location-scoped iteration on this foundation.
