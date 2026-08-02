# ADR 0102 — License Plates as inventory-bearing handling units

**Status:** Accepted (2026-08-02)
**Related:** ADR 0064 (locations & quants), ADR 0066/0067 (lot & serial),
ADR 0079 (Inventory ↔ Warehouse split), ADR 0101 (WMS scan intents)

## Context

`wms_license_plates` existed as a labelled row: a code, a type, a status and
a `current_location_id`. Nothing hung off it. `stock_quants` had no plate
column, the detail page queried `package_id` (a product-packaging FK) as if
it were a plate id — so contents were empty by construction — and `move_lpn`
rewrote the plate's location without moving a single unit of stock. Physical
reality and the ledger diverged on every move. There were no split, merge,
nest or unnest operations, no scanning, and no label audit.

## Decision

A license plate is the identity of a physical handling unit, and stock is
held **on the plate**.

1. **Inventory-bearing plates.** `stock_quants.lpn_id` (nullable) carries the
   plate. The quant identity index becomes
   `(product_id, location_id, lot_number, package_id, owner_id, lpn_id)`, so
   loose stock and plate-held stock coexist in the same bin without
   colliding. No separate contents table: the canonical quant ledger stays
   the single source of truth for quantity, lot, owner and cost.
2. **Operations are RPCs, never client writes.** `wms_lpn_move`,
   `wms_lpn_load`, `wms_lpn_unload`, `wms_lpn_split`, `wms_lpn_merge`,
   `wms_lpn_nest`, `wms_lpn_unnest`, plus the existing
   `wms_transition_lpn` FSM. All `SECURITY DEFINER`, all business/branch
   guarded, all atomic: a move relocates the plate, every quant it holds and
   every nested child in one transaction.
3. **Audit ledger.** `wms_lpn_events` records every load, move, split,
   merge, nest, status change and label print/reprint for a plate, with
   from/to location, from/to status, counterpart plate and quantity delta.
4. **Server-side codes.** `wms_next_lpn_code` mints sequential per-business
   codes (`PLT-YYMM-NNNNN`); the browser no longer invents identifiers.
5. **Movement trigger contract.** `_maintain_stock_quants` upserts on the
   six-column identity and **skips** movements with
   `reference_type = 'wms_lpn'`, because the plate RPC has already adjusted
   the balances. Anything else double-counts.
6. **Scanning.** Plate surfaces subscribe to the existing WMS scan-intent
   registry (`putaway.lpn`, `putaway.bin`) — no second scanning stack. GS1
   payloads are pre-parsed by `interpretScan` before resolution.
7. **Printing.** Labels go only through `printWmsLabel` → `PrintService`.
   Plate-specific binding, the Generate → Preview → Print compile, and the
   reprint reason code live in `src/features/warehouse/lpn/lpnLabels.ts`,
   which writes a `label_printed` / `label_reprinted` event on the plate.

## Consequences

- `move_lpn` is deleted. `complete_putaway_task` calls `wms_lpn_move`, so
  putaway now relocates stock, not just the plate row.
- Any surface reading plate contents must filter `stock_quants.lpn_id`;
  `package_id` is packaging, never a plate.
- Stock-on-hand reports must decide explicitly whether they aggregate
  plate-held quants (they do, since `location_id` is still set).

## Guards

`src/test/architecture/lpn-handling-units.test.ts` pins: no client write to
`wms_license_plates` operational columns, no `package_id`-as-plate query, no
`move_lpn` call site, plate pages subscribe to a scan intent, and plate
label printing goes only through the LPN label module.
