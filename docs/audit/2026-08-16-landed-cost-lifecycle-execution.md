# Landed Cost — Phase A lifecycle execution (live data)

Voucher `LCV-2026-00001` (KES 74 customs duty, value basis) was driven through
the full lifecycle against the live database, over goods receipt
`284b78c0…` (Sugar, 500 received, 152 already sold, 348 on hand).

| Step | Result |
| --- | --- |
| `landed_cost_allocate_voucher` | 74.00 allocated, 1 line, ratio 1.0, basis value 60 000 |
| `landed_cost_post_voucher` | capitalised 51.50 / expensed 22.50 (348 : 152 split), JE-00019 balanced 74/74 — Dr Inventory 51.50, Dr COGS 22.50, Cr Landed Cost Clearing 74.00 |
| `landed_cost_reverse_voucher` | compensating journal 74/74, cost layer restored to 2.4000, original journal preserved, revaluation rows stamped `reversed_at` |

`approval_route` gates on `auth.uid()`, so posting must be driven by an
authenticated caller — the `p_actor` argument alone is not sufficient. That is
by design; the RPC is reached from the app with a bearer token.

## Defect 1 — capitalisation never moved AVCO

`inventory_apply_cost_revaluation` re-priced the cost layer (2.4000 →
2.5480) but left `warehouse_stock.average_cost` and `products.cost_price` at
2.40. `check_inventory_valuation_drift` reported the full 51.50 as drift in
both scopes, and any sale after posting would have taken COGS at the
pre-landed-cost unit cost.

Fix: the revaluation ledger now drives AVCO. `inventory_sync_avco_from_layers`
re-derives warehouse and product AVCO from the surviving cost layers and is
invoked by `trg_inventory_revaluation_avco_sync` on insert/reversal of
`inventory_cost_revaluations`. Both are registered in
`inventory_valuation_writers`, so `check_valuation_writer_coverage()` stays
clean and ADR 0078's single-writer rule still holds. Existing drift was
repaired in the same migration.

Post-fix: AVCO 2.5480 while posted, 2.4000 after reversal, zero drift in both
scopes at each step.

## Defect 2 — landed-cost events dead-lettered

`_emit_landed_cost_outbox` emits `procurement.landed_cost.{submitted,
allocated,posted,reversed}`, none of which were registered in the
outbox-dispatcher's closed handler registry; both live events failed with
`posting.contract_violation: unknown_event_type`. Registered as record-only
lifecycle topics (state is already durable). Re-queued events now succeed.

## Rounding tolerance

`products.cost_price` is `numeric(15,2)` while layer AVCO carries four
decimals, so the product-scope drift check reported a 0.70 rounding artefact on
348 units. The check now allows half a cent per unit at product scope (and a
negligible per-unit allowance at warehouse scope) before reporting drift.
