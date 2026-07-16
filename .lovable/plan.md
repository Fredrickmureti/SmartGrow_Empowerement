
# Inventory Foundation — Architectural Verdicts

Scope: is the inventory engine capable of being the single source of truth for POS, Purchasing, Warehouse, Finance, Sales, Returns, Manufacturing? Evidence drawn from `products`, `product_identifiers`, `product_packaging`, `units_of_measure`, `warehouses`, `warehouse_stock`, `warehouse_stock_lots`, `stock_movements`, `stock_lots`, `stock_adjustments`, `stock_transfers`, `stock_reservations`, `goods_receipts`, `cost_layers`, plus surfaces in `src/hooks/useInventory.ts`, `src/lib/inventory/*`, `src/features/purchases/goods-receipt`, ADRs 0001/0002/0016/0023/0024/0025/0026/0035.

Legend: ✅ correct · ⚠ needs improvement · ❌ architecturally wrong.

## 1. Product master — ⚠
Rich (49 cols) with categories, suppliers, base UoM (immutable via trigger — ADR-0035), lot/expiry flags, cost method AVCO (ADR-0002). Weaknesses:
- No first-class **variant/parent-template** model (color/size matrix). Variants are today flattened to distinct products, blocking retail apparel/SKU-explosion workflows enterprise ERPs (Odoo `product.template`/`product.product`, Dynamics dimensions) rely on.
- No **serial-controlled** flag or serial ledger table. `is_lot_tracked`/`is_expiry_tracked` exist; serial does not. Blocks electronics, medical devices, warranty/RMA.
- No **product lifecycle state** (draft/active/discontinued/blocked) beyond `is_active`. No effective-dated attribute history.
- Brands, attributes, retail vs wholesale scoping present only as ad-hoc columns, not as a controlled taxonomy.

## 2. Barcode / identifier architecture — ✅ (with one gap)
`product_identifiers` with `(business_id, code_norm, kind)` unique constraint + `packaging_id` FK (pack-scoped barcode) is enterprise-shaped. Supports multiple codes, kind (EAN/UPC/GTIN/internal/supplier), and per-pack barcodes (carton/pallet via packaging rows). Regression tests exist (`product_identifiers_unique_shape_test.sql`).
- ⚠ Missing: explicit `supplier_id` on identifier rows (supplier-specific barcode aliasing) and GS1 AI parsing (weight-embedded, lot-embedded, expiry-embedded barcodes). Needed for pharmacy/FMCG at scale.

## 3. Multi-unit inventory — ✅
ADR-0024 + `products.base_uom_id` immutable + `product_packaging` factor-based + `formatQty` helpers + `enforce_product_uom_category` trigger. Base is source of truth, packs are presentation. Per-pack pricing is derived. This is correctly modelled — a genuine strength.

## 4. Warehouse / location model — ❌ (foundational gap)
Only `warehouses` (18 cols, branch-scoped) exists. There are **no zones, aisles, bins, or storage locations**. `warehouse_stock` aggregates at warehouse level; per-lot balances exist but no per-bin. Consequences:
- Cannot support WMS putaway, pick paths, bin-level cycle counts, or 3PL directives.
- Cannot model quarantine/damaged/staging as locations (today they'd be separate warehouses — a hack).
- Every enterprise WMS (SAP EWM, D365 WHS, NetSuite WMS, Odoo Enterprise) treats **stock quant = (product, location, lot, package, owner)**. We only carry (product, warehouse, lot). This is the single biggest structural gap.

## 5. Batch / lot architecture — ⚠ (correct core, thin metadata)
`stock_lots` + `warehouse_stock_lots` + trigger-maintained per-lot balances + FEFO RPCs (`resolve_fefo_lots`, `consume_lots_atomic`) + drift view (ADR-0025). Core is right.
- ⚠ `stock_lots` lacks first-class `manufacture_date`, `supplier_lot_ref`, `country_of_origin`, `certificate_of_analysis` link — required for pharma/food traceability.
- ⚠ No **lot genealogy** (parent lot → child lot from repack/manufacturing). Blocks two-way recall (upstream + downstream).
- ✅ `lot_quarantine` table exists but is not wired to a location/status state machine.

## 6. Serial numbers — ❌
No `stock_serials` table, no `is_serial_tracked` column, no serial movement ledger. Serialised inventory is entirely unsupported. Must be added before we claim ERP parity.

## 7. Goods Receipt / receiving — ⚠
`goods_receipts` + `goods_receipt_items` + wizard UI + `complete_goods_receipt_atomic` RPC. PO-linked receiving works, partial receipts are modelled (`backorders` table exists), branch-stamped moves are enforced. Gaps:
- ❌ **No ASN / EDI 856 / inbound-shipment model.** Nothing represents "supplier has shipped, expect these lots on this date." Enterprise receiving reconciles GRN against ASN, not PO directly.
- ⚠ No **receiving discrepancy** first-class object (over/short/damaged captured as movement notes, not as a structured claim record).
- ⚠ No **quality inspection** step between GRN and available stock (would need `lot_quarantine` + location state).
- ✅ Cross-dock and returns-to-vendor supported via `purchase_returns`.

## 8. Import architecture — ❌
Migration UI at `src/components/migration/steps/MigrationStepInventory.tsx` mixes concerns. Enterprise pattern separates: Product Master, Identifiers/Barcodes, Packaging, Opening Balances, Lots, Price Lists, Supplier catalogs — each idempotent, keyed, and reversible. Current design conflates them, which will not scale to multi-thousand-SKU onboardings.

## 9. Traceability — ⚠
Given the ledger + lot balances + reference_type/reference_id on `stock_movements`, upstream trace (which supplier, PO, GRN produced this lot) is answerable. Downstream trace (which customer/invoice/POS transaction consumed a lot) is **partially** answerable: `pos_transaction_items`, `invoice_items`, `delivery_note_items` do not consistently stamp `lot_number`. Full recall (`Which customers bought Batch A?`) is not reliably supported today.

## 10. Stock movement engine — ✅ (with one policy issue)
Single `stock_movements` table + `recordStockMovement` helper + branch trigger + AVCO cost layers + reservation table + adjustment reversal via `reverse_stock_adjustment_atomic` (ADR-0016). Movement types: purchase, sale, pos_sale, pos_return, adjustment, return_in, return_out, transfer, opening, receipt, delivery, scrap, count.
- ⚠ `transfer` collapses two logical events (issue + receive) into one type. Enterprise ERPs model `transfer_out` and `transfer_in` separately so in-transit stock is a real state. Today in-transit is implicit.
- ⚠ No `manufacturing_consumption` / `manufacturing_output` types. Adding manufacturing later will require broadening the enum.

## 11. Integration seams — ✅
Sales, Purchases, POS, Finance all route through `stock_movements` with branch-derived triggers (`inventory-verdict.md` audit is current). Inventory is behaving as SoT for quantity and value. This is the healthiest part of the stack.

## 12. Realtime & offline — ✅
`RealtimeSyncProvider` subscribes finance-critical inventory tables in one channel; POS has SQLite offline mirror. Sound.

---

# Verdict summary

| Area | Verdict |
|---|---|
| Product master | ⚠ (no variants, no serial, thin lifecycle) |
| Identifiers / barcodes | ✅ (needs supplier-aliasing + GS1 parsing) |
| Multi-UoM | ✅ |
| Warehouse locations / bins | ❌ **foundational gap** |
| Lot / batch | ⚠ (thin metadata, no genealogy) |
| Serial numbers | ❌ |
| Goods receipt / ASN | ⚠ (no ASN, no QC step) |
| Import architecture | ❌ (monolithic) |
| Traceability | ⚠ (downstream lot stamping incomplete) |
| Movement engine | ✅ (split transfer, add mfg types) |
| Cross-module integration | ✅ |

**Overall:** the inventory *ledger* is enterprise-shaped and safe (AVCO, lot-aware, branch-isolated, reversible, drift-monitored). The *master data & warehouse topology* are retail-shaped and will not scale to WMS/manufacturing without three structural additions: **locations/bins**, **serials**, and **inbound shipments (ASN)**. Variants and lot genealogy are the next tier.

---

# Recommended sequencing (no code yet — for approval)

Only structural work. No screen patches.

1. **Locations & bins**: introduce `stock_locations` (warehouse → zone → bin, typed: internal/quarantine/staging/transit/customer/vendor/scrap). Migrate `warehouse_stock` → `stock_quants (product, location, lot, package_id?, owner_id?)`. This is invasive but unlocks WMS, QC, in-transit, and correct quarantine.
2. **Serial numbers**: `stock_serials`, `products.is_serial_tracked`, movement-level serial linkage.
3. **ASN / inbound shipments**: `inbound_shipments` + `inbound_shipment_items` between PO and GRN; wire GRN wizard to reconcile against ASN.
4. **Product variants**: promote `products` to a template/variant pair (or attribute-matrix on the existing row) — decide via ADR before implementing.
5. **Downstream lot stamping**: enforce `lot_number` on `invoice_items`, `delivery_note_items`, `pos_transaction_items` for lot-tracked products; back-fill migration; RLS test.
6. **Split transfer events**: `transfer_out`/`transfer_in` with an in-transit location.
7. **Import architecture**: split monolithic importer into six idempotent pipelines (Master, Identifiers, Packaging, Opening Balances, Lots, Price Lists).
8. **Lot genealogy + richer lot metadata**: parent/child lot links, manufacture date, supplier lot ref, CoA storage.
9. **GS1 barcode parsing + supplier-aliased identifiers**.

Each step is a separate ADR + migration + focused PR. No step should be started before the previous one's ADR is approved.

## Deliverable of this audit
This document is the deliverable. No code changes were made. Awaiting your decision on which of steps 1–9 to schedule, and in what order.
