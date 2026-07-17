# Inventory Foundation — Execution Log & Roadmap

_Last updated: after Phase E (Product Variants)._

## ✅ Completed (verified, guards green)

### Phase 1 — Verification of prior work
- ADRs 0064–0069 present on disk.
- 92 inventory-foundation architecture guards inherited green.
- Primitives verified: `LotPickerPopover`, `SerialPickerPopover`, `OutboundLineTracking`, `outboundLineTrackingUtils.ts`, `useProductTrackingFlags`.
- ASN backend verified: `createAsnBatchImportHandler` + `ASN_IMPORT_FIELDS` in `src/lib/importConfigs/`, GRN wizard has ASN prefill + serial capture.

### Phase A.6 — Edit-path picker parity
- `InvoiceEditPage` covered via shared `InvoiceLineRow`.
- `CreditNoteEditPage.tsx` — `OutboundLineTracking` mounted on edit path.
- `SerialPickerPopover` bug fix: `warehouse_id` → `current_warehouse_id`.

### Phase D.3 — ASN Inbound Shipments UI
- `InboundShipments.tsx`, `InboundShipmentDetail.tsx`, routes + nav, guard `inbound-shipments-ui.test.ts` (10 tests).

### Phase G — Lot Genealogy & Traceability View
- ADR 0070, `Lots.tsx`, `LotDetail.tsx`, canonical `business_id + product_id + lot_number` on `stock_movements`, guard `lot-genealogy-ui.test.ts` (11 tests).

### Phase H — GS1 AI parsing on scanner input
- ADR 0071, `src/lib/gs1/` (aiTable, parseGs1, useGs1Scanner) + 12 parser tests, wired into GRN wizard + Lot/Serial pickers, guard `gs1-parsing.test.ts`.

### Phase E — Product Variants ✅ NEW
- **ADR 0072** — `docs/adr/0072-product-variants.md`. Doctrine: variants are first-class `products` rows joined by `variant_parent_id`; parent rows are never transacted (pickers exclude `is_variant_parent = true`).
- **Migration**: `product_variant_axes` (business-scoped) + `product_variant_axis_values` (axis-scoped) with RLS via `user_can_access_business`; adds `variant_parent_id`, `is_variant_parent`, `variant_axis_values jsonb` to `products` with `chk_variant_parent_not_self` and `chk_parent_xor_child` invariants. GRANTs to `authenticated` + `service_role`; no anon.
- `src/features/inventory/variants/generateVariantMatrix.ts` — pure cartesian generator + deterministic `deriveVariantSku` + `sameCoord`. 12 unit tests.
- `src/features/inventory/variants/useVariantAxes.ts` — react-query hooks over the axes catalogue.
- `src/features/inventory/variants/ProductVariantsPanel.tsx` — mounted in `ProductForm` (edit mode). Manages axes/values, previews the matrix, generates only missing coordinates, copies parent pricing/UoM/tracking/accounts to children, sets `is_variant_parent = true` on the parent before inserting children, links to per-variant edit page.
- Guard: `src/test/architecture/product-variants.test.ts` — ADR present, migration invariants + GRANTs, ProductForm imports the panel, matrix generator is pure, panel writes `variant_parent_id`.

**Current guard surface: ~130+ tests.**

---

## ⏭️ Deferred — remaining pillars

### Phase F — Product Import Split (variant-aware)
Split the monolithic product importer into six focused importers: Product master (parent + child rows via axes catalogue), Barcodes, Batch/Lot, Warehouse Stock, Price lists, Supplier links. Each with its own `importConfig`, batch handler, guard. ADR 0073.

### Phase 5 (ambient) — `warehouse_stock` retirement
Precondition: 14 consecutive clean `check_stock_quant_drift` runs. Once green: drop `warehouse_stock`, redirect residual readers to `stock_quants`. Migration + ADR 0074.

### Phase E+ follow-ups
- Update transactional product pickers (POS, invoice line, GRN, sales order) to filter `is_variant_parent = false` and expand parent → variants in the search dropdown.
- Per-variant image gallery (currently inherits parent `image_url`).
- Retro-migrate existing "size-in-name" products into structured axes.

### Explicitly out of scope
- Sales-order line editor lot/serial pickers (SO doesn't move stock).
- Edit pages for sales returns & delivery notes (don't exist).

---

## 🎯 Next execution — Phase F or Phase 5 ambient

Phase F landing order:
1. ADR 0073 — one importer per artefact; each importer emits idempotent business events.
2. Variant-aware Product master importer: parent + child rows via `variant_parent_id`.
3. Barcodes, Batch/Lot, Warehouse Stock, Price lists, Supplier links as independent import configs + batch handlers.
4. Guard: `src/test/architecture/product-import-split.test.ts`.
