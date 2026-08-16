# Landed Cost — Phase B: reversal after stock movement

Phase A proved the happy path (allocate → post → reverse with no activity in
between). Phase B asks the question that actually happens in an operating
business: **what if stock moved between posting the landed cost and reversing
it?** Reading the two functions involved showed the answer was wrong twice.

## Defect 1 — the unwind divided by the wrong quantity

`inventory_reverse_cost_revaluation` reduced the layer's unit cost by
`amount_applied / cost_layers.qty_remaining` — the quantity on hand *now*.
The uplift, however, had been `amount_applied / qty_remaining_at_apply`.

Consequence, with the live Sugar layer (348 units on hand, 51.50 capitalised,
uplift 0.14799/unit): sell 100 units, then reverse, and the layer's unit cost
drops by `51.50 / 248 = 0.20766` — the remaining 248 units end up **0.0597 per
unit below** their pre-landed-cost value. Fully consume the layer and the
unwind silently does nothing at all while the ledger still credits inventory
the full amount.

The uplift is a per-unit figure, so the unwind is too. It now subtracts
`amount_applied / qty_remaining_at_apply` regardless of subsequent
consumption, and reports what that means in money:

- `unwound` — value still on hand, genuinely removed from inventory
- `consumed` — value that already left through cost of sales
- `by_product` — the same split keyed by product, for the ledger

## Defect 2 — the reversal journal mirrored the original entry

`landed_cost_reverse_voucher` copied the original journal's lines with debit
and credit swapped. After a sale, that credits Inventory for value inventory
no longer holds and leaves the corresponding cost sitting in COGS forever.

The reversal journal is now **built**, not mirrored:

| Line | Source |
| --- | --- |
| Credit Inventory | `unwound` per product (product GL ladder, company role fallback) |
| Credit COGS | `consumed` per product — capitalised value already sold since posting |
| Credit COGS | `expensed_amount` per product — value already sold at posting time |
| Credit expense accounts | non-capitalisable components, unchanged |
| Debit Landed Cost Clearing | the sum, so clearing always washes to zero |

It still posts through `post_journal_entry_atomic` (ADR 0123), still requires
a reason, still checks the period lock, and never deletes journal history.

## Verification (live database, rolled back)

A cloned voucher over the real Sugar receipt was posted, 100 units were
consumed from the layer, and the voucher was reversed — all inside an aborted
transaction, so nothing persisted:

```
post:      capitalised 51.50 / expensed 22.50
layer:     2.4000 -> 2.5480 -> 2.4000     (exact restoration despite the sale)
inventory: unwound 36.70, consumed 14.80
reversal:  Dr Landed Cost Clearing 74.00
           Cr Inventory            36.70
           Cr COGS                 22.50   (sold before posting)
           Cr COGS                 14.80   (sold after posting)
balance:   0.00
```

Before the fix the same scenario produced `Cr Inventory 51.50` and a layer
under-costed by 0.0597/unit.

Post-check: one voucher (`LCV-2026-00001`, reversed), layer at 2.4000 with 348
on hand, `check_inventory_valuation_drift()` returns zero rows.

## Ratchet

`supabase/tests/landed_cost_reversal_split_test.sql` locks in: the
`qty_remaining_at_apply` unwind, the per-product split, a built (not mirrored)
reversal journal, single overloads, the shared journal writer, the mandatory
reason, and two live-data invariants (no open revaluations on a reversed
voucher, every landed-cost journal balanced).

## Known limitation — inter-warehouse transfers

`inventory_apply_cost_revaluation` matches layers by
`cost_layers.warehouse_id = goods_receipts.warehouse_id`. If receipted stock is
transferred to another warehouse *before* the landed cost is posted, the
destination layer is not matched, so that portion is treated as no longer on
hand and expensed to COGS rather than capitalised at the destination. No
transfer has consumed a cost layer in live data yet (only `delivery` and
`pos_sale` do). Closing this requires layer lineage across transfers and is
tracked as the next Phase B item.
