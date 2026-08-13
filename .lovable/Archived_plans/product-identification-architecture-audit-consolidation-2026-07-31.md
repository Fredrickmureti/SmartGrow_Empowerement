# Product Identification Architecture — Audit & Consolidation

## What enterprise systems actually do

Mature ERP/WMS/POS platforms (SAP, EWM, Oracle Retail, D365, Odoo, Manhattan, LS Central) do not model "a product barcode". They model an **identifier registry** where every row answers three questions:

1. **What logical item is this?** (product / variant)
2. **What physical object was scanned?** (base unit, inner pack, case, pallet — i.e. a packaging level)
3. **What quantity, in base UoM, does one of those represent?**

Two universal principles follow:

- The identifier points at a **packaging level**, never at a bare "quantity number". Quantity is derived from the packaging row, so a pack factor can never disagree with the barcode.
- Identification is **many-to-one and typed**: a case can carry a GTIN-14, a supplier code, and a legacy alias simultaneously; scanning any of them yields the same physical object.

Serial/lot/LPN identity (GS1 AIs, SSCC, license plates) is a *separate* layer that sits on top of item identity — the platform already has that layer (`parseGs1`, `wms_license_plates`).

## What this codebase actually has (verified)

Good news: the foundation exists and is better than the request implies.

- `product_identifiers(product_id, code, kind, is_primary, pack_quantity)` with `kind ∈ gtin|sku|pack|supplier|internal|plu|alias`, unique on `(business_id, code_norm, kind)`. Multi-barcode is already supported.
- `product_packaging(product_id, name, qty_in_base_uom, barcode_id, is_purchase_default, is_sales_default)` — the pack hierarchy.
- `pos_resolve_barcode` already resolves an identifier, then looks up `product_packaging WHERE barcode_id = matched identifier`, and returns `packaging_id` + converted `scan_quantity`.
- GS1 parsing, WMS scan intents, serials, LPNs all exist.

The real defects are these:

1. **Two competing truths for pack quantity.** `product_identifiers.pack_quantity` (a free number) and `product_packaging.qty_in_base_uom` (the canonical hierarchy). `pos_resolve_barcode` falls back to the loose number when no packaging is bound, so the same barcode can mean 12 in POS and 10 in Inventory. There is no FK, no constraint, nothing keeping them equal.
2. **The link points the wrong way.** `product_packaging.barcode_id → product_identifiers` allows only **one** identifier per packaging level, and nothing stops two packaging levels binding the same identifier. The enterprise shape is the inverse: `product_identifiers.packaging_id → product_packaging` (nullable = base unit), many identifiers per level.
3. **Barcode Enrollment is level-blind.** `useProductsAwaitingBarcode` asks only "does this product have any `gtin`/`pack` row?" A milk packet with a barcode but an unlabelled 6-pack and pallet is considered *done*. The workspace never reads `product_packaging`, never shows which levels are missing, and always enrolls at product level with `kind='gtin'`.
4. **Warehouse surfaces don't resolve identity at all.** `ReceivingSessions` and the GRN wizard take `resolveCode` and put it in a toast/reason string — no product lookup, no packaging level, no quantity conversion. Receiving a case therefore cannot auto-expand to base units.
5. **A legacy `products.barcode` path still exists** in the Electron SQLite cache and offline bridge (guarded by a test, but still the schema of record offline).

## What to build

### A. One canonical model (migration)

- Add `product_identifiers.packaging_id uuid NULL REFERENCES product_packaging(id) ON DELETE CASCADE`. `NULL` = base unit.
- Backfill from the existing `product_packaging.barcode_id` bindings, and from `pack_quantity` where it matches exactly one packaging row's factor.
- Add a validation trigger: an identifier's packaging row must belong to the same product/business.
- Deprecate then drop `product_identifiers.pack_quantity` and `product_packaging.barcode_id` once backfilled — quantity comes from the packaging row only. Where `pack_quantity` cannot be matched to a packaging level, create the packaging row (named from the factor) rather than keeping the loose number.
- New RPC `resolve_product_identity(business, branch, code)` returning `{product, packaging_level, qty_in_base_uom, uom, matched_kind, gs1}` — one resolver for every module. `pos_resolve_barcode` becomes a thin POS-shaped wrapper over it (POS pricing/tax columns stay) so POS behaviour is unchanged.
- New RPC `product_identification_status(business, product_ids[])` returning, per product, each packaging level and whether it carries a scannable identifier — the projection the enrollment queue needs.

### B. Enrollment becomes a lifecycle workspace

- `useProductsAwaitingBarcode` → `useIdentificationQueue`, backed by `product_identification_status`. A product is "complete" only when every packaging level (plus base unit) has an identifier, or the level has been explicitly marked *not identified* (an intentional skip, recorded, not guessed).
- The workspace shows the product's packaging ladder (Packet → 6-Pack → Carton → Pallet) with a per-level state: identified / missing / intentionally skipped, and drives the scan cursor **level by level** rather than product by product.
- `enroll_product_barcode` gains `p_packaging_id` and infers `kind` (`gtin` at base, `pack` above base, `supplier` when enrolling against a supplier context). Existing 3-arg calls keep working.
- Add "not identified at this level" as a first-class recorded decision so the queue can distinguish *unknown* from *deliberately unlabelled*.

### C. Every module consumes the same resolver

- WMS receiving, put-away, picking, counts, and the GRN wizard call `resolve_product_identity` through one shared hook, so a scanned case posts `qty_in_base_uom` base units against the right product instead of a display string.
- Purchasing: supplier identifiers resolve at receiving, and supplier-code + packaging level together drive the received quantity.
- Label printing (`resolveLabelBarcode`, ADR-0089) becomes level-aware: printing a case label uses the case identifier, never the base GTIN, and still refuses rather than falling back to an internal ID.

### D. Remove the drift

- Delete `product_packaging.barcode_id` and `product_identifiers.pack_quantity` reads/writes across `ProductPackagingEditor`, `ProductIdentifiersEditor`, `useProductDetailData`, import configs, and the offline bridge.
- Retire the legacy `products.barcode` column from the Electron SQLite schema; the offline cache mirrors `product_identifiers`.
- New ADR (0090) recording the identity contract; extend the existing guard tests so the old shapes cannot come back.

## Sequencing

1. Migration A (additive: `packaging_id`, backfill, new RPCs) — nothing breaks yet.
2. Enrollment workspace rebuilt on the new status projection.
3. Module cutover to the shared resolver (WMS, GRN, purchasing, labels).
4. Drop the deprecated columns + delete legacy paths, ADR + guard tests.

Steps 1–2 are shippable on their own; step 4 is the point at which the ERP no longer has a concept of "the product barcode".

## Note

This is a large change touching POS scanning, receiving, and printing. Step 1 is designed to be strictly additive so the current POS scan path keeps working throughout; the destructive column drops happen only in step 4, after every reader has moved.
