# Landed Cost — Phase B item 1: cost must follow stock across warehouses

Scenario rehearsed (rolled back, nothing persisted): 500 Sugar received at HQ,
152 sold, 100 transferred to a second warehouse, then landed cost voucher
`LCV-2026-00001` (KES 74 duty, value basis) posted.

The rehearsal could not even be started: three defects, each in a different
canonical engine, sat between a transfer and a landed cost.

## Defect 1 — the movement vocabulary was stale

`stock_movements_movement_type_check` permitted only 15 types, while the
canonical engines emit `transfer_out` / `transfer_in`
(`approve_stock_transfer_atomic`, `complete_stock_transfer_atomic`,
`consume_lots_atomic`, `wms_lpn_dispatch`, `wms_lpn_move`,
`wms_split_putaway_task`), plus `adjustment_in`, `adjustment_out`,
`opening_stock`, `customer_return` and `vendor_return`. **Every
inter-warehouse transfer in the product failed at approval** — which is why the
database holds zero stock transfers. The constraint now carries the vocabulary
the engines emit, and the missing types were registered in
`inventory_movement_event_classes` so the event fabric classifies them
(`tg_stock_movement_emit_event` refuses an unmapped type).

## Defect 2 — two irreconcilable representations of "in transit"

Dispatched stock was parked on the business transit location, created with
`warehouse_id IS NULL`. Warehouse balances are projected from quants through
`stock_locations.warehouse_id` (ADR 0142), so that location projected onto no
warehouse: the in-transit warehouse always read zero, and receiving the goods
failed with `Insufficient stock in warehouse. Available: 0`.
`get_business_transit_location` now scopes the transit location to the
business's `is_in_transit` warehouse (adopting the legacy warehouse-less row
rather than minting a rival), so one representation serves both ledgers.

## Defect 3 — transferring stock destroyed its value

The transfer engines do not stamp `unit_cost` on the movement legs, so the
destination cost layer was created at 0.00. Lineage rows existed but carried no
cost. `_maintain_cost_layers` now derives the inbound layer's cost as the
quantity-weighted cost of the consumptions it descends from, and re-derives
destination AVCO through `inventory_sync_avco_from_layers` — the registered
valuation writer, so ADR 0078's single-writer rule still holds.

## Rehearsal result after the fixes

| Stage | Evidence |
| --- | --- |
| Transfer | HQ 248 @ 2.4000, destination 100 @ 2.4000 (was 0.0000), lineage 100 traced from the receipt layer |
| Post | capitalised 51.50 across **both** warehouses — HQ 36.70 on 248, destination 14.80 on 100 — expensed 22.50 for the 152 sold |
| Journal | Dr Inventory 51.50, Dr COGS 22.50, Cr Landed Cost Clearing 74.00 — balanced |
| Valuation | AVCO 2.5480 in both warehouses; `check_inventory_valuation_drift()` returns no rows |

So `inventory_apply_cost_revaluation` already follows lineage across warehouses;
what was missing was a working transfer and a cost to follow.

Ratchet: `supabase/tests/landed_cost_transfer_lineage_test.sql`.
