# UoM & Packaging — Independent Re-audit (2026-06-08)

Re-audit of the Phase A/B UoM + packaging rollout shipped by the previous agent
across migrations `20260527131853`, `20260527132826`, `20260527141306` and the
associated UI/hooks. Auditor: independent second pass.

## Verdict per claim

| Claim from hand-off | Reality on inspection |
|---|---|
| `uom_categories`, `units_of_measure`, `product_packaging` tables exist | ✅ Real, RLS + grants + seed function correct. |
| `products.base_uom_id / sales_uom_id / purchase_uom_id` + default trigger | ✅ Real, backfilled, trigger live. |
| `display_uom_id` + `display_quantity` + `packaging_id` on 7 line tables | ✅ All 7 tables (invoice_items, sales_order_items, purchase_order_items, goods_receipt_items, pos_transaction_items, stock_adjustment_items, stock_transfer_items). |
| `_uom_normalize_line` BEFORE triggers | ✅ Wired on all 7 tables; `quantity` stays canonical in base units. |
| `convert_uom`, `resolve_barcode_v2`, `pos_resolve_barcode` v2 | ✅ Real. `pos_resolve_barcode` returns `packaging_id` + `base_uom_id`. |
| `process_pos_transaction` persists packaging on items and on `stock_movements` | ✅ Verified. |
| `cost_layers` + `cost_layer_consumptions` + maintenance trigger | ✅ Real, fires on every movement. |
| `PackagingSelect` component lists packs per product | ❌ **Was broken.** Queried non-existent columns (`label, pack_quantity, uom_id`). Fixed in R1: now queries `id, name, qty_in_base_uom`. |
| Invoice create + edit persist packaging fields | ✅ Both write paths persist; BEFORE trigger renormalizes. |
| GRN dialog persists packaging fields | ✅ Verified. |
| POS cart + scan thread packaging end-to-end | ✅ Verified through `usePOSCart`, `usePOSTransactionOffline`, `useResolveBarcode`, `POSTerminal`, RPC. |
| `InventorySettings` cost_model toggle in Company Settings | ⚠️ UI works and `businesses.cost_model` column exists, but **no runtime consumer existed.** Addressed in R4 by `compute_unit_cost(business_id, product_id, warehouse_id)` helper. Wire-up to invoice/POS/GRN COGS sites is a follow-on — see "Open work". |
| `source_packaging_id` / `source_uom_id` on `stock_movements` populated from every write path | ⚠️ Only POS stamped `source_packaging_id`. **Fixed in R2** by a new AFTER-INSERT trigger `_backfill_movement_packaging` that resolves the source line by `(reference_type, reference_id, product_id)` for invoice / goods_receipt / stock_adjustment / stock_transfer movements. No RPC rewrites required. |
| Plan/audit document the previous agent claimed to produce | ❌ Not in repo before this pass. This file is the missing audit. |

## Additional gaps surfaced this pass

1. **No operator UI for `units_of_measure` / `uom_categories`.** Users get the four seeded UoMs only; cannot add Liter / Meter / Roll / custom factor. Blocks the "universal ERP" goal. **Status: deferred — see Open work.**
2. **`product_packaging.barcode_id` could not be set from the UI.** The schema supported it but the editor had no picker, so the "Direct packaging barcode hit" branch of `resolve_barcode_v2` was dead code. **Fixed in R3** — `ProductPackagingEditor` now has a barcode dropdown that lists `product_identifiers` rows for the product.
3. **No `cost_model='fifo'` recosting / cutover RPC.** Switching mid-life will not re-value historical movements. **Status: deferred** — out of scope per plan; documented in ADR 0023.
4. **Idempotency of normalization on UPDATE.** The trigger recomputed `quantity = display_quantity * pack_qty` on every UPDATE, even when the caller only touched `quantity`. **Fixed in R8** by gating the renormalization to inserts and to updates that actually touch the display/packaging columns.
5. **Reports do not show pack rollups.** "Stock on hand: 50 ea" is correct but not what operators read for shelves. **Helper shipped in R6** (`src/lib/packagingRollup.ts`). Wiring into individual reports is straightforward presentation work and is left as a follow-on.

## Shipped this re-audit

| ID | Change | Files |
|----|--------|-------|
| R1 | Fix `PackagingSelect` to use real columns + update parent callback | `src/components/products/PackagingSelect.tsx`, `src/components/invoices/InvoiceLineRow.tsx` |
| R2 | New trigger backfills `source_packaging_id`/`source_uom_id` on stock_movements from the originating line | migration `20260527-uom-reaudit` |
| R3 | Barcode picker in `ProductPackagingEditor` writes `product_packaging.barcode_id` | `src/components/products/ProductPackagingEditor.tsx` |
| R4 | `compute_unit_cost(business_id, product_id, warehouse_id)` SQL helper branching on `businesses.cost_model` | migration `20260527-uom-reaudit` |
| R6 | `formatBaseQtyAsPacks` presentation helper | `src/lib/packagingRollup.ts` |
| R7 | This audit + ADR 0023 | `docs/audit/2026-06-08-uom-packaging-reaudit.md`, `docs/adr/0023-uom-and-packaging-domain.md` |
| R8 | Guard `_uom_normalize_line` so quantity-only UPDATEs are not silently reverted | migration `20260527-uom-reaudit` |

## Open work (explicitly deferred — call out before claiming "done")

- **R5 — UoM management page.** Full CRUD UI for `units_of_measure` + `uom_categories`, including category-reference selection and the `factor_to_reference` / `rounding` / `uom_type` invariants. Pure UI but non-trivial; warrants its own loop.
- **R4 wire-up.** `compute_unit_cost(...)` exists as a single source of truth, but the existing invoice / POS / GRN / adjustment RPCs still read `products.cost_price` directly for COGS. Migrating those call-sites to the helper is the second half of the FIFO-toggle promise. Each RPC must be re-emitted with care; recommend one RPC per migration.
- **R6 wire-up.** `formatBaseQtyAsPacks` is shipped; wiring into "Stock on Hand", "Inventory Valuation", and product-detail views remains. Each report consumer is a small, isolated edit.
- **Multi-UoM pricing.** Selling a carton for 22 KES and a piece for 1 KES requires `product_pricing(packaging_id, price)`. Not on the critical path; modeled in ADR 0023 as a future phase.
- **Lot/serial × packaging × FIFO** interaction polish — `cost_layers` already carry lot/serial; the UI does not surface them per pack.

## Validation performed

- Schema verified against migration 20260527131853 (`product_packaging` columns).
- Cross-checked write paths in `src/hooks/useInvoicesPaginated.ts` (createInvoice), `src/components/invoices/EditInvoiceDialog.tsx`, `src/components/purchases/GoodsReceiptDialog.tsx`, `src/hooks/pos/usePOSCart.ts`, `src/hooks/pos/usePOSTransactionOffline.ts`, `src/pages/pos/POSTerminal.tsx`.
- Cross-checked RPC writes to `stock_movements`: only `process_pos_transaction` stamped `source_packaging_id` before R2; the new trigger closes the gap uniformly.
- Reviewed `_uom_normalize_line` and `_uom_normalize_line_grn` for the UPDATE-silently-reverts hazard; R8 patches both.

## Risk

All R1–R8 changes are additive. R2's backfill trigger only sets columns when they are NULL — it never overrides an explicit value (POS rows already populated by `process_pos_transaction` are untouched). R8 is a behavior softening. R4's helper is unused at call sites today; adding it cannot regress current behavior. R3 and R6 are pure UI / pure helpers.
