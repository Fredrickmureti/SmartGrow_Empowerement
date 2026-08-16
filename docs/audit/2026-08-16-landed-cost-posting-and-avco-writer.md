# Landed Cost — posting the physical-basis vouchers, and the AVCO writer defect it exposed

Date: 2026-08-16

## Posting executed

`landed_cost_post_voucher` accepts an explicit actor but `approval_route` reads
`auth.uid()`, so posting was driven from a migration that set the owner's JWT
claim for the transaction. Governance was not bypassed: the organization is in
`solo` governance mode and the actor is the owner, so
`governance_assert_not_self` auto-allowed and wrote the
`sod.self_action_auto_allowed` audit row.

| Voucher | Basis | Amount | Journal | Result |
| --- | --- | ---: | --- | --- |
| LCV-2026-00002 | weight | 8,000 KES | `bf498bff…` | posted, capitalised 8,000 |
| LCV-2026-00003 | volume | 3,000 KES | `68ec37d1…` | posted, capitalised 3,000 |

Both journals are balanced and identical in shape: **Dr 1200 Inventory /
Cr 2099 Landed Cost Clearing**, `source_type = 'landed_cost_voucher'`, nothing
expensed (no stock consumed yet). One `procurement.landed_cost.posted` outbox
event per voucher, both `succeeded`.

Revaluation applied at the layer level, in posting order:

- Sugar 2.4000 → 33.3469 (+6,189.38), then → 45.0542 (+2,341.46)
- Cooking Oil 12.5000 → 42.6770 (+1,810.62), then → 53.6527 (+658.54)

## Defect found by the post-posting drift check

`check_inventory_valuation_drift()` returned one row — **Chair**: layers 42,500
against AVCO 35,000, a 7,500 gap. Chair is unrelated to landed cost, so the
posting was not the cause; the drift check simply surfaced it.

Root cause: `update_weighted_avg_cost_on_receipt()` was a **second costing
authority** beside the cost layers. It computed

```
old_qty := products.stock_quantity - NEW.quantity
```

but `trg_update_wac_on_receipt` fires before `trigger_update_product_stock`, so
`stock_quantity` did not yet include the receipt. `old_qty` went negative, the
`old_qty <= 0` branch was taken, and AVCO was **replaced by the last purchase
price** instead of being blended. This mis-costed every receipt into existing
stock, company-wide and per warehouse.

## Fix (at the canonical engine, not locally)

`update_weighted_avg_cost_on_receipt()` is now a thin delegation to
`inventory_sync_avco_from_layers(business, product, warehouse)` — the same
engine landed cost, transfers and revaluation already use. Cost layers are the
single valuation truth; AVCO is derived, never independently computed. The
migration also re-derived AVCO for every product with remaining layers.

Result: Chair AVCO 2,000 → **2,428.57** ((7.5×3,000 + 10×2,000) / 17.5), and
`check_inventory_valuation_drift()` now returns **0 rows**.

## Ratchet

`supabase/tests/inventory_avco_single_writer_test.sql` fails if the receipt
trigger stops delegating, reintroduces its own `stock_quantity`/`average_cost`
arithmetic, if a second `inventory_sync_avco_from_layers` appears, or if live
valuation drift is non-zero.

## Still open

Phase F2 — a real transfer-then-reverse across two warehouses. `stock_transfers`
is still empty, so the warehouse-split reversal remains rehearsal-only.
