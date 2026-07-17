# Inventory Foundation — Execution Log & Roadmap

_Last updated: handoff checkpoint after Phase H._

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
- **Scope note:** `SalesReturnEditPage.tsx` and `DeliveryNoteEditPage.tsx` do not exist; create-surface pickers cover their lifecycle.

### Phase D.3 — ASN Inbound Shipments UI
- `InboundShipments.tsx`, `InboundShipmentDetail.tsx`, routes + nav, guard `inbound-shipments-ui.test.ts` (10 tests).

### Phase G — Lot Genealogy & Traceability View
- ADR 0070, `Lots.tsx`, `LotDetail.tsx`, canonical `business_id + product_id + lot_number` on `stock_movements`, guard `lot-genealogy-ui.test.ts` (11 tests).

### Phase H — GS1 AI parsing on scanner input ✅ NEW
- **ADR 0071** — `docs/adr/0071-gs1-scanner-parsing.md`.
- `src/lib/gs1/aiTable.ts` — data-only AI catalogue (GTIN, lot, expiry, production, serial, count, weight/measure family, FNC1).
- `src/lib/gs1/parseGs1.ts` — pure table-driven parser. Handles ]C1/]d2/]e0/]Q3 symbology prefixes, leading FNC1, fixed-length + variable-length AIs, `310n` decimal indicators, YYMMDD with day-00 → last-day-of-month.
- `src/lib/gs1/useGs1Scanner.ts` — `interpretScan(raw)` returns `{ resolveCode, isGs1, normalized }` so legacy resolvers keep working; GS1 payloads collapse to their GTIN for barcode lookup.
- `src/lib/gs1/parseGs1.test.ts` — 12 table tests across all AI families + failure modes.
- **Wired:**
  - `GoodsReceiptWizardPage.tsx` — line scan resolves GTIN → product, prefills `lot_number`, appends scanned `serial_number(s)`, honours AI 30 quantity, expiry surfaced in the scan flash.
  - `LotPickerPopover.tsx` — new `scannedLot` + `scannedExpiry` props emit an override allocation pinned to the scanned batch (falls back to a synthetic row when the lot is not yet in FEFO suggestions).
  - `SerialPickerPopover.tsx` — new `scannedSerial` prop auto-selects the matching in-stock serial when it appears in the loaded set.
- Guard: `src/test/architecture/gs1-parsing.test.ts` — parser isolation (imports only from `./aiTable`), AI table coverage, scanner hook wraps parser, GRN wizard imports `useGs1Scanner`, both pickers accept scanned props, ADR 0071 present.

**Current guard surface: ~125/125 (Phase H adds ~13 tests to the 112 baseline).**

---

## ⏭️ Deferred — remaining pillars (in vision order)

### Phase E — Product Variants
Variant axis model (size/color), variant SKU generation, price/stock per variant, barcode per variant. ADR 0072. Migrations required.

### Phase F — Product Import Split
Split the monolithic product importer into six focused importers: Product master, Barcodes, Batch/Lot, Warehouse Stock, Price lists, Supplier links. Each with its own `importConfig`, batch handler, guard. ADR 0073.

### Phase 5 (ambient) — `warehouse_stock` retirement
Precondition: 14 consecutive clean `check_stock_quant_drift` runs. Once green: drop `warehouse_stock`, redirect residual readers to `stock_quants`. Migration + ADR 0074.

### Optional Phase H+ follow-up
- POS scan input GS1 wiring: audit `src/features/pos/` scanner mount points; if a surface reads raw scan strings directly, route them through `interpretScan` (single-line change per site).
- Feed AI 17 expiry into `goods_receipt_items` so `stock_lots.expiry_date` upserts on receipt (currently expiry only shown in the scan flash; lot master captures it on the FEFO path).

### Explicitly out of scope (cosmetic / non-blocking)
- Sales-order line editor lot/serial pickers (SO doesn't move stock).
- Edit pages for sales returns & delivery notes (don't exist).

---

## 🎯 Next execution — Phase E (Product Variants)

Landing order recommendation:
1. ADR 0072 — variant axis + SKU generation grammar; decide whether variants are a first-class table or a self-referencing product hierarchy.
2. Migration: `product_variant_axes`, `product_variant_values`, `products.variant_parent_id`.
3. Product form UI: axis + value picker, variant matrix, per-variant barcode/price/stock.
4. Downstream stamping: POS lookup, invoice line, GRN line resolve variant SKUs.
5. Guard: `src/test/architecture/product-variants.test.ts`.

**Do NOT** start Phase F (import split) or Phase 5 (warehouse_stock retirement) until Phase E lands green — the import split needs the variant schema to model per-variant rows.
