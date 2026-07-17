# ADR 0074 — Product imports split by concern

## Status
Accepted — 2026-07-17.

## Context
`productImportConfig.ts` had grown into a single field list that mixed product
master, barcode/GTIN, batch/lot, warehouse-stock, price-list and supplier
pricelist concerns. Each of those concerns has different resolution rules,
different destination tables, and different post-insert side effects
(triggers, movements, GS1 parsing). Keeping them merged made every downstream
importer either accept fields it shouldn't or hand-roll its own subset.

## Decision
Split the config into six focused modules under
`src/lib/importConfigs/product/`:

1. `productMasterImportConfig.ts` — identity, pricing, classification, UoM.
2. `productBarcodeImportConfig.ts` — `product_identifiers` rows.
3. `productBatchImportConfig.ts` — `stock_lots` rows (lot, mfg, expiry).
4. `productWarehouseStockImportConfig.ts` — opening balance by warehouse.
5. `productPriceImportConfig.ts` — `price_list_items` tiers.
6. `productSupplierImportConfig.ts` — `vendor_pricelists` entries.

`productImportConfig.ts` remains as a deprecated compat shim so existing
Migration and Products page importers keep working. A new architecture guard
(`product-imports-are-split`) forbids new callers from importing the legacy
symbol.

## Consequences
- Each importer picks the exact concern it owns.
- Split configs can grow (extra fields, custom resolvers) without polluting
  siblings.
- Follow-up: split-config-specific batch handlers can be added incrementally.
