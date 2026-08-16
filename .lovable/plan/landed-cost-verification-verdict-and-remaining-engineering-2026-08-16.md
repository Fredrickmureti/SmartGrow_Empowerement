# Landed Cost — Verification Verdict and Remaining Engineering

## Phase 1 verdict: the previous engineer's claims check out

Verified directly against the live database (not from notes):

| Claim | Verdict |
| --- | --- |
| One overload each for the allocate / post / apply / reverse writers, the three valuation engines, `resolve_product_measure`, the four reporting RPCs, `get_next_grn_number` | Confirmed — exactly one of each |
| LCV-2026-00002 / 00003 posted, 8,000 and 3,000 fully capitalised, journals attached | Confirmed |
| LCV-2026-00001 reversed with a reversal journal | Confirmed |
| LCV-2026-00004 still `draft`, the refusal fixture | Confirmed (no journal, no allocation) |
| AVCO has a single writer — the receipt trigger only delegates | Confirmed (the function is a 373-character delegation) |
| `check_inventory_valuation_drift()` = 0 rows | Confirmed |
| Landed-cost outbox events all succeeded | Confirmed — 4 of 4 |
| Product physical attributes captured for the weight/volume proof | Confirmed — 4 rows |
| Transfer case never actually exercised | Confirmed — `stock_transfers` is empty and `cost_layer_lineage` has 0 rows |

No fabricated completion found. The one item billed above its evidence is the
transfer/reversal case, exactly as the handoff note admitted.

## New defect found during this verification

`inventory_reverse_cost_revaluation` and `landed_cost_reverse_voucher` contain no
reference to `warehouse_id`, while `inventory_apply_cost_revaluation` and
`inventory_sync_avco_from_layers` are both warehouse-aware. The apply path stamps
value per warehouse; the reverse path cannot see that split. On any voucher whose
stock moved between warehouses before reversal, value will be unwound in the wrong
warehouse scope. This is a canonical-engine defect and is fixed there, not in
landed cost.

## Remaining work, in order

### F2 — transfer → post → reverse, on real data (active)

Receive a lot into warehouse A, transfer part of it to warehouse B through the
canonical transfer path (`approve_stock_transfer_atomic` / `complete_stock_transfer_atomic`
— confirm the creation writer first; never write `stock_transfers` directly), consume a
small quantity at B so the reversal must split between on-hand value and COGS, then
create, allocate, post and reverse a voucher against the receipt.

Assert: both origin and destination layers return to their pre-landed-cost unit cost;
the consumed portion is corrected through COGS; AVCO is re-derived per warehouse by
`inventory_sync_avco_from_layers` alone; drift is 0 rows in both warehouse scopes; the
reversing journal balances and a reversal event exists.

Fix the warehouse blindness above in `inventory_reverse_cost_revaluation` (and the
journal split in `landed_cost_reverse_voucher`) as part of this phase. Land
`supabase/tests/landed_cost_transfer_reversal_test.sql` and an audit note.

### G2 — goods-receipt reversal and supplier credit note against a posted voucher

Two lifecycle branches the parent prompt calls out that remain unproven: reversing a
goods receipt that already carries a posted landed cost, and a supplier credit note
against a landed-cost bill. Decide and enforce the rule server-side (block versus
auto-reverse), prove it on real data, ratchet it.

### H — finish document numbering (WMS writers)

Six functions still mint identifiers from UUID fragments — confirmed live:
`create_pick_wave`, `open_pack_carton`, `receive_goods_to_wms`,
`wms_enqueue_order_for_wave`, `wms_plan_waves`, `wms_split_putaway_task`. Route each
through the canonical numbering engine, renumber existing rows chronologically, and
extend `document_numbering_no_uuid_test.sql`. Keys that never surface in a document,
screen or report may stay UUID-based only with that proven and stated.

### I — authenticated UI verification

Still blocked: the project uses an external Supabase, so no session can be minted in
the sandbox. Verify public routes only and record the limitation. No simulated session.

## Working rules carried forward

Landed Cost stays a consumer, never an authority. One writer per operation. Every
discrepancy is fixed at the canonical engine. Refuse rather than fabricate. Real RPCs
on real data — a rolled-back rehearsal is never the final proof.
