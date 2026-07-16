# Inventory Foundation — Execution Log & Roadmap

_Last updated: handoff checkpoint after Phase G._

## ✅ Completed (verified, guards green)

### Phase 1 — Verification of prior work
- ADRs 0064–0069 present on disk.
- 92 inventory-foundation architecture guards inherited green.
- Primitives verified: `LotPickerPopover`, `SerialPickerPopover`, `OutboundLineTracking`, `outboundLineTrackingUtils.ts`, `useProductTrackingFlags`.
- ASN backend verified: `createAsnBatchImportHandler` + `ASN_IMPORT_FIELDS` in `src/lib/importConfigs/`, GRN wizard has ASN prefill + serial capture.

### Phase A.6 — Edit-path picker parity
- `InvoiceEditPage` already covered via shared `InvoiceLineRow` (verified).
- `CreditNoteEditPage.tsx` — `OutboundLineTracking` mounted on edit path.
- `SerialPickerPopover` bug fix: `warehouse_id` → `current_warehouse_id` (actual column on `stock_serials`); guard updated.
- **Scope note:** `SalesReturnEditPage.tsx` and `DeliveryNoteEditPage.tsx` **do not exist** in this codebase — sales returns & delivery notes are create-only today. Create-surface pickers already cover their full lifecycle. If edit pages are ever built, A.6 must be revisited.

### Phase D.3 — ASN Inbound Shipments UI
- `src/pages/inventory/InboundShipments.tsx` — list view, status filter, CSV Import action wired to `createAsnBatchImportHandler` + `ImportWizard`.
- `src/pages/inventory/InboundShipmentDetail.tsx` — header, lines, "Start Goods Receipt" deep-links to GRN wizard via `?po=` contract.
- Routes registered in `src/apps/inventory/routes.tsx`.
- Nav entry "Inbound (ASN)" added in `src/apps/inventory/nav.ts` under Operations.
- Guard: `src/test/architecture/inbound-shipments-ui.test.ts` (10 tests).

### Phase G — Lot Genealogy & Traceability View
- **ADR 0070** — `docs/adr/0070-lot-genealogy-traceability.md`.
- `src/pages/inventory/Lots.tsx` — index of `stock_lots`, filters (product, supplier, expiry).
- `src/pages/inventory/LotDetail.tsx` — origin (supplier + GRN), on-hand distribution per warehouse (net), chronological movement timeline with resolved `reference_type` labels.
- Canonical traceability query pinned: `business_id + product_id + lot_number` on `stock_movements`.
- Routes + nav entry "Lots & Traceability" registered.
- Guard: `src/test/architecture/lot-genealogy-ui.test.ts` (11 tests).

**Current guard surface: 112/112 green.**

---

## ⏭️ Deferred — remaining pillars (in vision order)

### Phase H — GS1 AI (Application Identifier) parsing on scanner input  ⬅ **NEXT**
**Why next:** highest enterprise-retail leverage; unlocks single-scan capture of GTIN + batch + expiry + serial on inbound and outbound flows. Keeps momentum on the traceability spine we just completed.

Deliverables:
- `src/lib/gs1/parseGs1.ts` — parse GS1-128 / DataMatrix payloads (AIs: `01` GTIN, `10` batch/lot, `17` expiry YYMMDD, `21` serial, `310n` weight, `30` count, plus FNC1 handling).
- Hook `useGs1Scanner` — wraps existing scan input, returns structured `{ gtin, lot, expiry, serial, quantity }`.
- Wire into: GRN wizard line entry, `LotPickerPopover`, `SerialPickerPopover`, POS scan input.
- ADR 0071 — GS1 barcode doctrine.
- Guard: `src/test/architecture/gs1-parsing.test.ts` (parser table-tests + integration mount points).

### Phase E — Product Variants
- Variant axis model (size/color/etc.), variant SKU generation, price/stock per variant, barcode per variant.
- ADR 0072. Migrations required. Not additive — schema touch.

### Phase F — Product Import Split
Split the monolithic product importer into six focused importers:
1. Product master
2. Barcodes
3. Batch/Lot
4. Warehouse Stock
5. Price lists
6. Supplier links

Each with its own `importConfig`, batch handler, and guard. ADR 0073.

### Phase 5 (ambient) — `warehouse_stock` retirement
- Precondition: 14 consecutive clean `check_stock_quant_drift` runs.
- Once green: drop `warehouse_stock`, redirect any residual readers to `stock_quants`. Migration + ADR 0074.

### Explicitly out of scope (cosmetic / non-blocking)
- Sales-order line editor lot/serial pickers (SO doesn't move stock).
- Edit pages for sales returns & delivery notes (don't exist; would be net-new features, not wiring).

---

## 🎯 Next execution — Phase H (GS1 parsing)

**Files to create:**
- `src/lib/gs1/parseGs1.ts` + `src/lib/gs1/aiTable.ts`
- `src/lib/gs1/useGs1Scanner.ts`
- `docs/adr/0071-gs1-scanner-parsing.md`
- `src/test/architecture/gs1-parsing.test.ts`
- Unit tests for parser table.

**Files to modify (wire scanner):**
- `src/features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx` (line scan input)
- `src/components/inventory/LotPickerPopover.tsx` (accept scanned lot+expiry)
- `src/components/inventory/SerialPickerPopover.tsx` (accept scanned serial)
- Any POS scan input in `src/features/pos/` (verify surface first).

**Success criteria:**
- Single scan of a GS1-128 label on GRN populates GTIN → product resolve, lot, expiry in one action.
- Parser handles FNC1 group separator + fixed-length vs variable-length AIs correctly.
- Guard surface grows 112 → ~125 tests, all green.
- No schema changes, no RPC changes.

**Pick-up instruction for the next engineer:**
Start with `parseGs1.ts` + its unit table (pure function, no UI). Land ADR 0071 in the same turn. Wire scanner hook into GRN wizard first (highest-value surface), then pickers. Do NOT touch product-variant or import-split work until Phase H is guarded green.
