# Sugar simulation — verification verdict and continuation (sell side)

## Phase 1 — what I verified directly (not from the hand-off note)

Checked against the codebase and the live database:

| Claim / item | Verdict | Evidence |
|---|---|---|
| Sugar configured: base UoM KG + "50 kg Bag" = 50 KG | Confirmed | one product in the catalogue, one packaging row, factor 50 |
| Opening stock 500 KG via real receiving | Confirmed and reconciled | `stock_quants` 500, `warehouse_stock` 500, `products.stock_quantity` 500, 1 stock movement |
| Phase 2 structured snapshots on line tables | Confirmed | `uom_snapshot_pack_name/_factor/_base_code` present; normalizer + parity tests pass |
| Phase 3 ledger provenance (`stock_movements`, `stock_quants`) | Confirmed | provenance columns + `supabase/tests/ledger_uom_provenance_test.sql` |
| Phase 4 one formatter | Confirmed | `src/lib/inventory/uom.ts` owns the contract and re-exports the rollup primitives from `formatQty.ts` |
| Phase 7 POS fractional entry | Confirmed in code | `POSUnitSelectDialog` allows 0.001 steps for non-count base units, keeps integer clamp for packs; not yet exercised as a real POS sale |
| Sales line captures the sell unit | Partially confirmed | a **draft** invoice exists carrying quantity 50 / display 1 / pack "50 kg Bag" / factor 50 / base KG — provenance is right, but it was never posted, so no inventory movement, no document, no proof |

Genuinely not done (so the simulation is unproven from step 3 onward):

- No 17 kg, 50 kg, 2/1/5/25 kg sale has been executed; nothing posted; stock is still exactly 500 KG.
- No POS transaction exists for Sugar (`pos_transaction_items` = 0 rows).
- No document/receipt has been generated and inspected.
- Only Sugar exists — the "is this generic?" question (volume, length, countable) is untested.
- Phase 6 document convergence is incomplete: `purchasesRequisition`, `purchasesRfq`, `wmsReturn`, `posReceipt`, `posKitchenTicket` do not use `LINE_ITEM_UOM_SELECT`.
- Phase 8 not started: no `is_sellable`/`is_purchasable` on `product_packaging`; `rfq_items` outside the provenance model; `products.weight_unit`/`tare_weight` not retired.
- Known upstream defect left standing: on `purchase_order_items`, `enforce_line_uom_consistency` fires before `_uom_normalize_line`, so a client sending display+packaging with no pre-computed base is rejected instead of normalised.

## Phase 2 — corrections to the previous plan

1. The draft invoice is not evidence. Every sell-side step must be driven through the real UI (Playwright against the running app) and end in a **posted** document with a matching stock movement.
2. Document inspection must include the rendered PDF/receipt strings, not just the snapshot row — the "17 kg vs 17 ea" question is answered by the renderer, not the table.
3. Generic-capability proof needs one product per dimension (volume, length, count) created through the same product form, otherwise "Sugar works" proves nothing.

## Phase 3 — execution order

**Step 1 — Sell 17 kg (loose).** Real invoice through the Sales UI, posted. Verify: line reads `17 kg` (no pack, no invented `ea`), `quantity` 17 base, ledger movement 17 with display 17 / factor 1, on-hand 483 across quants, warehouse_stock and `products.stock_quantity`.

**Step 2 — Sell 1 × 50 kg Bag.** Verify line reads `1 50 kg Bag (50 KG)`, base movement 50, on-hand 433, and that the frozen snapshot survives a later packaging rename.

**Step 3 — Denomination sweep.** 2 kg, 1 kg, 5 kg, 25 kg. After each, assert `start − qty = end` and that the unit stays KG. Record a running ledger table.

**Step 4 — POS.** Sell 2 kg loose and 1 × 50 kg Bag through the POS workspace. Verify cart, tender, transaction items, ledger movement and on-hand.

**Step 5 — Documents.** Generate and read the invoice PDF and the POS receipt for the 17 kg, 1-bag and 2 kg events. Confirm the printed quantity strings match the in-app formatter.

**Step 6 — Database trace.** Product → UoM → packaging → line → movement → quant → document snapshot for each event; state which column is canonical and where a value is derived vs frozen.

**Step 7 — Generic proof.** Create Cooking Oil (L, 20 L container), Cable (m), Chair (count) through the product form; one sale each in a fractional and a packaged denomination; POS rejects 2.5 chairs.

**Step 8 — Close the known gaps** (only after the diagnostic run, so failures are captured first):
- `LINE_ITEM_UOM_SELECT` wired into requisition, RFQ, WMS return, POS receipt, kitchen ticket, plus a snapshot test asserting every line-item document kind selects the provenance columns.
- PO trigger ordering fixed so normalisation runs before the consistency check.
- Phase 8 items: `is_sellable`/`is_purchasable` on `product_packaging`, `rfq_items` brought into the provenance model at `numeric(15,4)`, `products.weight_unit`/`tare_weight` retired after confirming the POS scale-barcode path reads `product_physical_attributes`.

**Step 9 — Final verdict** in the requested structure: configuration, events executed, expected vs actual table, layer where semantics are lost, per-domain impact (inventory, purchasing, receiving, sales, invoicing, POS, returns, credit notes, reporting, documents), architecture verdict, then remediation.

## Diagnostic discipline

Steps 1–7 are read-and-record: a failure is reproduced, traced to its layer and written down, not patched mid-run. Fixes land in step 8, in the owning domain, with a migration and a guard test each.

## Technical notes

Browser automation drives the real app on localhost with the injected session; database checks use read queries only. Any schema change ships as a migration with a `supabase/tests/` guard. No new UoM table, packaging table, conversion engine or formatter is introduced — everything converges on `units_of_measure` + `convert_uom` + `product_packaging` + `resolve_line_base_quantity` + `src/lib/inventory/uom.ts`.
