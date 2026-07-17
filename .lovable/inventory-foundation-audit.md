# Inventory Foundation Audit — Verdict

**Date:** 2026-07-17 · **Scope:** Inventory as ERP foundation (not POS-only) · **Method:** schema sweep + ADR review + code trace. Evidence links inline.

## Scoring key
✅ Ready · ⚠️ Gap (fix-forward) · ❌ Missing (foundational hole)

---

## 1. Product Master — ⚠️ Gap

**Evidence:** `products` (53 cols), `product_categories`, `product_variant_axes` (6 cols), `product_variant_axis_values` (5 cols), `product_packaging`, `product_reorder_rules`. Import split ADR 0074.

- Rich flags for lot/serial/expiry (`is_lot_tracked`, `is_serial_tracked`, `is_expiry_tracked`, `expiry_alert_days`).
- Base-UoM immutability enforced (ADR 0035, `enforce_base_uom_immutable`).
- **Variant model is shallow**: axes/values tables exist but there is no `product_template` ↔ `product_variant` split — variants appear to be sibling `products` rows joined via axis values, not a template with SKU-attribute matrix (Odoo/NetSuite pattern).
- 53 columns suggests some retail/pharmacy fields inlined onto the master (drug-schedule, controlled-substance markers) rather than pushed into extension tables. Country-agnostic assertion holds but modularity is thin.

**Benchmark:** SAP/D365/NetSuite use `product_template → product_variant → variant_attribute_value`. Odoo Enterprise same. We conflate template and variant.

**Remediation:** Introduce `product_templates` + `product_template_axes`; keep `products` as the variant row with a nullable `template_id`. Move retail/pharmacy vertical fields to `product_regulated_attributes` (JSONB or typed extension table).

---

## 2. Barcode Architecture — ✅ Ready

**Evidence:** `product_identifiers` (1:N, `kind` enum {gtin8/12/13/14/isbn/custom}, `is_primary`, `pack_quantity`, `code_norm` for search). Split barcode import (`productBarcodeImportConfig.ts`). Realtime hook `useProductIdentifiersRealtimeSync`.

- Per-packaging barcodes via `pack_quantity` (case/pack/each all supported).
- Supplier vs internal via `kind=custom` + notes; explicit `supplier` kind would be cleaner but not blocking.
- Normalisation column supports scanner-safe lookup.

**Benchmark:** matches SAP `MEAN` (multiple EANs), Odoo `product.barcode` + pack barcodes.

**Remediation:** minor — add `kind='supplier'` and a `supplier_id` FK for reverse lookup during ASN receipt.

---

## 3. Multi-Unit Inventory (UoM) — ✅ Ready

**Evidence:** `units_of_measure`, `uom_categories`, `products.base_uom_id`, `product_packaging(qty_in_base_uom)`, ADR 0023/0024/0035. Presentation contract `mem/features/multi-unit-inventory.md`. Trigger `enforce_line_uom_consistency` (test: `supabase/tests/line_uom_consistency_test.sql`). Every transactional line carries `packaging_id`, `display_quantity`, `display_uom_id`.

- Base-unit-of-truth invariant enforced in DB + TS.
- Sales/Purchase/Stock UoMs must share category (`enforce_product_uom_category`).
- Immutability triggers on base UoM once transacted.

**Benchmark:** parity with Odoo's UoM engine; stricter than most.

**Remediation:** none.

---

## 4. Batch/Lot — ✅ Ready

**Evidence:** `stock_lots` (14 cols: mfg, expiry, supplier_id, goods_receipt_id), `warehouse_stock_lots` (per-lot balance), FEFO RPCs (`resolve_fefo_lots`, `consume_lots_atomic`), ADR 0025, `lot_quarantine`, `product_recalls`, downstream stamping ADR 0066, genealogy ADR 0070 with `v_lot_downstream_consumption` view.

**Benchmark:** matches SAP `MCH1`/`MCHA` + batch derivation; Oracle `INV_LOT_NUMBERS`.

**Remediation:** none for foundation. Recall UI is a separate deliverable.

---

## 5. Serial Number Architecture — ✅ Ready

**Evidence:** `stock_serials` (per-unit ledger — status, current_location_id, current_warehouse_id, last_movement_id, received/shipped_at, lot_number parent), ADR 0067, `products.is_serial_tracked`. Movements carry `serial_number`; downstream tables stamp it (ADR 0066).

**Benchmark:** matches Oracle `MTL_SERIAL_NUMBERS`, Odoo `stock.production.lot` (serial variant).

**Remediation:** none.

---

## 6. Goods Receipt — ⚠️ Gap

**Evidence:** `goods_receipts` (13 cols, `purchase_order_id`, `warehouse_id`, `status`), `goods_receipt_items` (18 cols: qty_ordered, qty_received, lot, serial, packaging_id, uom_snapshot, unit_cost_basis), `goods_receipt_discrepancies` (18 cols), `inbound_shipments` (19 cols — ASN, ADR 0069), `backorders` (11 cols).

- Partial receipt: ✅ (qty_ordered vs qty_received).
- Over/under receipt captured via discrepancies.
- ASN present.
- **3-way match**: PO ↔ GRN links exist; bill ↔ GRN linkage not surfaced (`bills` table has no direct GRN FK based on schema). Matching may be by PO only, which is 2-way.
- **Landed cost**: no `landed_cost_allocations` table; `unit_cost_basis` text on line is a hint, not a mechanism.
- **EDI**: no evidence of an EDI parser layer; CSV upload only.

**Benchmark:** NetSuite has `LandedCost` records w/ allocation methods (qty, weight, value); SAP `MIGO` + `MRKO` for invoice verification (3-way).

**Remediation (ordered):**
1. Add `bills.goods_receipt_id` (nullable) + a `bill_grn_matches` junction to enable true 3-way match.
2. Add `landed_cost_bills` + `landed_cost_allocations` (allocation basis enum) to distribute freight/duty/insurance across GRN lines, feeding `cost_layers`.
3. EDI can be deferred — CSV + ASN cover 90% of retail SMB.

---

## 7. Product Import — ✅ Ready

**Evidence:** ADR 0074, split configs `productMasterImportConfig`, `productBarcodeImportConfig`, `productBatchImportConfig`, `productWarehouseStockImportConfig`, `productPriceImportConfig`, `productSupplierImportConfig`. Architecture guard `product-imports-are-split`. Legacy `PRODUCT_IMPORT_FIELDS` retained as deprecated shim.

**Benchmark:** matches SAP LSMW / NetSuite CSV concern-separation.

**Remediation:** finish deprecating the legacy union shim; add a staging table (`product_import_staging`) with row-level error surface — current importer writes direct-to-`products` which is fine for SMB scale but not for 100k-row loads.

---

## 8. Inventory Traceability — ✅ Ready

**Evidence:** downstream stamping ADR 0066 (invoice_items / sales_order_items / sales_return_items / credit_note_items / delivery_note_items / pos_transaction_items all carry `lot_number`/`serial_number`); unified view `v_lot_downstream_consumption`; genealogy ADR 0070; `product_recalls` + `product_recall_items`; `controlled_substance_register`.

Recall query "which customers bought Batch A?" answerable via one view. Origin (supplier lot, GRN, mfg date) on `stock_lots`.

**Benchmark:** SAP Batch Management + WM traceability; parity.

**Remediation:** none foundational.

---

## 9. Inventory Movement Engine — ⚠️ Gap

**Evidence:** `stock_movements` (24 cols: `movement_type`, `quantity` signed, `unit_cost`, `reference_type`+`reference_id`, `lot_number`, `serial_number`, `source_packaging_id`, `source_uom_id`, `source_location_id`, `destination_location_id`, `warehouse_id`, `branch_id`, `migration_session_id`, `is_sample_data`). `stock_quants` (product+location+lot+package+owner+qty+reserved), triggers `_maintain_warehouse_stock_lots` + `_maintain_cost_layers`. Directional transfer types (ADR 0068). Drift log ADR 0075. `stock_movements_orphans` isolation table. Adjustment↔GL integrity ADR 0016.

- **Location-aware quants** — matches Odoo model.
- **Idempotency**: server RPCs use idempotency keys (`business_event_outbox.idempotency_key`); `stockLedger.ts` client helper does not — but only one caller (`usePurchaseReturns.ts`) uses the client helper, and it's an inbound movement so acceptable.
- **Reversal semantics**: adjustment ADR 0016 mandates reversal; verify parity for transfers/GRN.
- **Cost method conflict** — this is the real gap. ADR 0002 declares "AVCO on receipt, snapshot on sale" as the single method, but `cost_layers` + `cost_layer_consumptions` tables (FIFO layer pattern) exist and have a trigger `_maintain_cost_layers`. Either ADR 0002 is stale or the FIFO ledger is dead code. **Decide and align — an ambiguous cost method is a finance-critical defect.**
- **Single writer** — `recordStockMovement` docstring claims single-writer status, but reality is: most writes are DB-side RPCs (145 migrations touch `stock_movements`). That's actually *better* than a TS single-writer, but the docstring lies. Update the contract.

**Benchmark:** Odoo `stock.move` + `stock.valuation.layer`. We have both halves; we just haven't decided which is canonical.

**Remediation:**
1. Publish an ADR amendment (0002-a) explicitly stating: AVCO is canonical, `cost_layers` supports FEFO cost consumption for lot-tracked products only, and audit that no other consumer reads `cost_layers`.
2. Update `stockLedger.ts` docstring to reflect that server RPCs are the primary writer; TS helper is for controlled client-inbound scenarios only.
3. Add a movement-reversal RPC contract (`reverse_stock_movement`) mirroring the adjustment pattern so every reference type has a canonical reversal.

---

## 10. Warehouse Architecture — ✅ Ready

**Evidence:** `warehouses` (18 cols, branch_id, is_in_transit flag), `stock_locations` (15 cols — `parent_location_id` gives hierarchy, `location_type` + `usage` enums for internal/transit/inventory-loss/customer/vendor/production/view). Transit + quarantine locations seeded (ADR 0065 referenced).

Hierarchy lives inside `stock_locations` (Odoo model — Site is a warehouse, Zone/Aisle/Bin are nested locations). This is the correct enterprise pattern.

**Benchmark:** matches Odoo warehouse+location model; SAP has Plant→SLoc→Bin — same shape.

**Remediation:** none.

---

## 11. Integration Readiness — ⚠️ Gap

**Evidence:** `business_event_outbox` (20 cols — `idempotency_key`, `claim_lease_seconds`, `worker_id`, `attempts`, `last_error`, `event_type`, `source_doc_type`, `payload jsonb`, `status`). `domainEventBus` + `BusinessSaga` in `src/services/events/`.

- Outbox pattern is well-designed.
- **However**, current consumers of `domainEventBus` are mostly POS/payroll/printing (`rg` evidence). Inventory-facing events (`stock.movement.created`, `stock.lot.created`, `goods_receipt.completed`) are not clearly published via the outbox — downstream modules (Finance JE, replenishment, alerts) currently couple to `stock_movements` triggers directly (145 migrations reference).
- Direct-table coupling is fine within one database but blocks event-sourced reporting, external WMS/EDI adapters, and cross-service scale.

**Benchmark:** NetSuite SuiteCloud events, D365 Business Events, SAP Event Mesh. All publish immutable inventory events.

**Remediation:**
1. Define a `stock.*` event contract (name, payload shape, versioning) — `stock.movement.posted`, `stock.lot.received`, `stock.transfer.dispatched`, `stock.transfer.received`, `stock.serial.status_changed`.
2. Publish via `business_event_outbox` from the same RPCs that write movements (single transaction).
3. Migrate one downstream consumer (Finance COGS JE, or replenishment) to subscribe to the outbox instead of polling movements, as proof.

---

## Executive Verdict

**As-is-with-targeted-fixes.** Not re-foundation. The engine is closer to enterprise-grade than the mandate implied — the last 12 ADRs (0064–0075) already delivered locations+quants, directional transfers, lot genealogy, serial ledger, downstream stamping, and drift observability. The foundation is real.

**Blocking gaps (3):**
1. **Cost-method ambiguity** (Pillar 9) — AVCO ADR vs cost-layer tables coexist without an authoritative reader. Finance-critical. Fix first.
2. **3-way match + landed cost** (Pillar 6) — required before Purchasing can run for goods with freight/duty. Retail/pharmacy will hit this immediately.
3. **Event outbox not populated for inventory** (Pillar 11) — the infrastructure exists; nothing publishes to it. Blocks external integration and event-driven reporting.

**Non-blocking improvements:** product template/variant split (Pillar 1), staging table for large imports (Pillar 7), supplier-barcode enum (Pillar 2), reversal RPC parity across all reference types (Pillar 9).

**Recommendation:** stop the audit here. Present the three blocking gaps to the user with the ordered remediation above and wait for a direction on which to migrate first. Do not open migrations without explicit go-ahead.
