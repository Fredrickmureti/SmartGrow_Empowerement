# UoM / Packaging / Quantity wave — verification verdict and continuation

## Phase 1 — independent verification of the previous engineer's claims

Each claim was checked directly against the codebase and the live database, not against the log.

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 1 — receiving conversion moved server-side | Confirmed | `src/pages/warehouse/ReceivingSessions.tsx` sends `receivedQty: 1` + `packagingId`; no client `toBase()` on the capture path; guard test `wms-server-authoritative-uom.test.ts` present |
| Phase 1 — purchase-order base normalization (the second P0, not mentioned in the hand-off note) | Confirmed, and it was actually done | trigger `trg_uom_normalize_po_items` (`_uom_normalize_line`) exists on `purchase_order_items`, alongside `enforce_line_uom_consistency` |
| Phase 2 — structured snapshot columns on all document-line tables | Confirmed | `uom_snapshot_pack_name` / `_factor` / `_base_code` present (checked `invoice_items`, `pos_transaction_items`, `purchase_order_items`); `_uom_normalize_*` + `enforce_line_uom_consistency` triggers on 15 line tables |
| Phase 2 — frozen snapshot honoured by the formatter | Confirmed | `resolveLineSnapshot` in `src/lib/inventory/uom.ts`; 8 tests pass, plus `supabase/tests/uom_structured_snapshot_test.sql` |
| Phase 5 — no stale `unit_of_measure ?? "ea"` | Confirmed | repo-wide search returns zero occurrences; `productBaseLabel` / `productBaseLabelOrUnset` / `PRODUCT_BASE_UOM_SELECT` consumed by the product tabs, `Products.tsx`, `Inventory.tsx`, `useProducts`, `useProductDetailData`, `useDashboardIntelligence`; `product-base-uom-label.test.ts` guard passes |

All 19 tests in the three UoM suites pass. No regressions found, no superficial patches found. The hand-off note under-reported: the PO trigger was also delivered.

Still open, verified as genuinely not done:

- `stock_movements`, `stock_quants`, `warehouse_stock` carry no `display_quantity` and no snapshot columns. `stock_movements` does have `source_packaging_id` / `source_uom_id`, so the ledger knows *which* pack but cannot state the commercial quantity — Phase 3 is real work, not a rename.
- Two live TS quantity formatters: `src/lib/inventory/formatQty.ts` (30+ importers, warehouse/reports) and `src/lib/inventory/uom.ts` (line-provenance path). `packagingRollup.ts` is already a thin re-export. Same maths today, nothing pins them together.
- `POSUnitSelectDialog.tsx` still clamps with `Math.max(1, Math.floor(...))` and `step={1}` — fractional weight/volume cannot be keyed in.
- `rfq_items.quantity` is outside the provenance model (no `display_quantity`, no snapshot columns).

## Phase 2 — plan corrections

Two additions to the previous plan, justified by the checks above:

1. **`stock_quants` provenance was scoped out of Phase 3.** The ledger and the on-hand projection must agree, otherwise the "9 × 50 kg bags + 33 kg loose" decomposition remains a client-side guess. Phase 3 covers `stock_movements` first and `stock_quants` in the same migration.
2. **Formatter convergence must be direction-corrected.** The old plan made `formatQty.ts` canonical; but the provenance-aware formatter lives in `uom.ts` and `formatQty.ts` knows nothing about frozen snapshots. `uom.ts` becomes the single owner; `formatQty.ts` keeps its pack-rollup helpers as internals re-exported from `uom.ts`, so the 30+ warehouse importers keep working unchanged.

## Phase 3 — work to execute now (in order)

**Step 1 — refresh the ledger file.** Rewrite `.lovable/plan/product-uom-packaging-quantity-audit-verdict-remediation-2026-08-15.md` with the verdicts above so Phases 1, 2 and 5 are recorded complete with evidence.

**Step 2 — Phase 3: physical-ledger provenance.** Migration adding `display_quantity`, `uom_snapshot_pack_name`, `uom_snapshot_factor`, `uom_snapshot_base_code` to `stock_movements` and `stock_quants`; a stamping trigger reusing the existing `_uom_normalize_line` logic (derived from `source_packaging_id` / `source_uom_id`, never new maths); backfill from existing packaging where derivable, left NULL where not; column comments declaring `quantity` as base units. SQL guard in `supabase/tests/` asserting a movement written from a 1 × 50 kg Bag line stores base 50, display 1, factor 50 — and does not drift when the pack is later re-specified.

**Step 3 — Phase 4: one formatter.** `uom.ts` re-exports the pack-rollup primitives; `formatQty.ts` becomes the internal implementation module; a golden case table (count, 1.25 kg, 2.5 L, 17.5 m, 1 × 50 kg Bag, multi-pack decomposition) asserts the TS formatter, the Deno `LineItemsTable.formatQtyCell` and `receipt/items.ts` render identical strings. An architecture test bans new direct `formatQty` imports outside `src/lib/inventory/`.

**Step 4 — Phase 6: document-template convergence.** Wire `LINE_ITEM_UOM_SELECT` into `purchasesRequisition`, `purchasesRfq`, `wmsReturn`; replace the inline label in `purchasesGrn`; snapshot test asserting every line-item document kind selects the provenance columns.

**Step 5 — Phase 7: POS fractional entry.** Remove the integer clamp when the resolved base UoM's category dimension is non-count, stepping by `units_of_measure.rounding`; keep integer enforcement for count products. Tests: cart accepts 2.5 kg for sugar, rejects 2.5 for a chair.

**Step 6 — Phase 8: applicability flags and legacy cleanup.** `is_sellable` / `is_purchasable` on `product_packaging`; `rfq_items.quantity` migrated to `numeric(15,4)` and brought into the provenance model; `products.weight_unit` / `tare_weight` retired after confirming the POS scale-barcode path reads `product_physical_attributes`.

## Business-event regression set (added incrementally per step)

10 × 50 kg → 500 kg; 500 − 17 → 483; 500 − 50 → 450; sell 1 × 50 kg Bag → base 50 with the document still reading "1 Bag"; return 5 kg → +5 base; partial receipt 6 then 4; kg→L rejected; posted invoice unchanged after a packaging edit; POS 2.5 kg accepted / 2.5 chairs rejected.

## Technical notes

Database work ships through migrations only. No new UoM table, packaging table, conversion engine or formatter is introduced at any step — every step converges consumers onto `units_of_measure` + `convert_uom` + `product_packaging` + `resolve_line_base_quantity` + `uom.ts`.
