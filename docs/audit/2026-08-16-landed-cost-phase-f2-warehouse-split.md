# Landed Cost — Phase F2: transfer, consume, post, reverse across two warehouses

Date: 2026-08-16

Phase F2 was the last rehearsal-only item in the landed cost domain: every
prior proof ran inside a single warehouse, so warehouse-split behaviour was
asserted by reading code rather than by moving stock. This session executed it
on live data.

## What was executed

All steps went through the canonical engines — no direct ledger or layer writes.

| # | Step | Engine |
| --- | --- | --- |
| 1 | Created `WH-NKR` (Nakuru Depot) + default location | table writes only |
| 2 | PO-2026-0005, 100 Cable @ 50 KES | `submit_purchase_order` → `approve_purchase_order` |
| 3 | GRN-2026-00004 into `WH-HQ` | `create_goods_receipt` |
| 4 | Transfer 40, then 96.5 HQ → NKR | `approve_stock_transfer_atomic` → `complete_stock_transfer_atomic` |
| 5 | Write off 10, then 40 at NKR | `apply_or_request_stock_adjustment` |
| 6 | LCV-2026-00005, 2,000 KES freight, value basis | `landed_cost_allocate_voucher` → `landed_cost_post_voucher` |
| 7 | Write off 20 more at NKR (post-uplift consumption) | `apply_or_request_stock_adjustment` |
| 8 | Reverse the voucher with a reason | `landed_cost_reverse_voucher` |

The two transfers were deliberate: the first drained older stock, the second
pushed 40 units of the *receipt's own* layer into Nakuru, so the receipt being
costed genuinely straddled two warehouses when the freight was posted.

## Result

Lineage recorded the full hop, HQ layer → in-transit layer → NKR layer, with
per-parent quantities (56.5 from the legacy layer, 40 from the receipt layer).

Posting uplifted **both** warehouses from the one voucher:

- `WH-HQ` receipt layer 50.0000 → 70.0000 on 60 remaining → 1,200
- `WH-NKR` descendant layer 50.0000 → 59.2486 on 86.5 remaining → 800
- Journal `8582cddb…`: Dr 1200 Inventory 2,000 / Cr 2099 Landed Cost Clearing 2,000

Reversal, after 20 uplifted units had been consumed at Nakuru:

- Dr 2099 Landed Cost Clearing 2,000
- Cr 1200 Inventory 1,815.03
- Cr 5010 Cost of Goods Sold 184.97  (= 20 / 86.5 × 800)

Both layers returned to exactly 50.0000, per-warehouse AVCO returned to 50.00,
all revaluations closed, one `procurement.landed_cost.posted` outbox event
succeeded, and `check_inventory_valuation_drift()` returns 0 rows.

## The suspected defect was not a defect

The prior verification flagged `inventory_reverse_cost_revaluation` and
`landed_cost_reverse_voucher` as "warehouse-blind" because neither takes a
warehouse argument. Live execution disproves the concern: both operate on
`cost_layers`, and a cost layer is warehouse-scoped by primary key. Tracing
descendants through `cost_layer_lineage` therefore lands in the correct
warehouse automatically, and the AVCO sync trigger re-derives per warehouse.
Adding a warehouse parameter would be redundant state, not extra safety.

One behaviour worth stating explicitly rather than "fixing": when a transfer
merges several parent layers into one destination layer, the uplift is applied
at that merged layer's unit cost, so it spreads over every unit in the merged
layer. The **amount** attributed to the receipt is exact (800 for 40 units);
only its per-unit spread follows the merge. That is inherent to layer merging
on transfer and is consistent with how transfers already value stock.

## Ratchet

`supabase/tests/landed_cost_warehouse_split_test.sql` fails if layers stop being
warehouse-scoped, if a completed transfer leaves no lineage, if a posted
voucher's capitalised amount stops matching the uplift actually applied, if a
reversal stops relieving the clearing account across inventory + COGS, if any
warehouse's AVCO diverges from its own layers, or if valuation drift returns.

## Domain status

Phases A through F2 are complete and proven on live data. The remaining open
item is Phase H — document numbering completion for the landed cost surfaces.