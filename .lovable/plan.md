# Inventory Foundation — Verification & Next Execution

## Phase 1 — Verification of prior engineer's claims

Verified directly against filesystem + live Supabase schema:

| Claim | Status |
|---|---|
| ADRs 0064–0072 on disk | ✅ all 9 present |
| Phase E migration executed (3 product columns + 2 axis tables) | ✅ confirmed via `information_schema` |
| `stock_serials`, `stock_quants`, `inbound_shipments(+_items)`, legacy `warehouse_stock(+_lots)` all present | ✅ 6/6 tables |
| Phase D.3 Inbound Shipments UI (`InboundShipments.tsx`, `InboundShipmentDetail.tsx`, guard) | ✅ present |
| Phase G Lot Genealogy (`Lots.tsx`, `LotDetail.tsx`, ADR 0070, guard) | ✅ present |
| Phase H GS1 (`src/lib/gs1/{aiTable,parseGs1,useGs1Scanner}.ts` + parser tests + guard) | ✅ present |
| Phase E authoring (`src/features/inventory/variants/*` + panel mounted in `ProductForm`) | ✅ present |
| Phase E+ variant-aware read paths | ❌ **not started** — `is_variant_parent` only referenced in the panel, ProductForm, guard, and generated types; **zero pickers, list, or report filter parents out** |
| Phase F import split | ❌ **not started** — only one `productImportConfig.ts`; no separate barcode/batch/warehouse-stock/price/supplier importers |
| Phase 5 retire `warehouse_stock` | ❌ **not started** — 20+ readers across POS, reports, hooks, pages |

The plan.md log is truthful. No claimed-complete item was found unimplemented.

## Phase 2 — Additions to the plan (from independent audit)

Three items belong in the roadmap that plan.md did not spell out as first-class tasks:

- **A. POS scanner GS1 wiring** — `interpretScan` exists but is only mounted in the GRN wizard and the two pickers. POS scan surfaces (`src/features/pos/…`) still consume raw scan strings, so a pharmacy scan won't populate lot/expiry at the till. Single-line route change per surface.
- **B. AI-17 expiry into GRN persistence** — parser surfaces expiry in the scan flash but does not upsert `stock_lots.expiry_date` on receipt; FEFO relies on it being present.
- **C. Product-recall RPC + Lot Genealogy UI action** — ADR 0070 landed the read path; there is no `recall_lot(business, product, lot)` RPC that (i) locks remaining on-hand into a `lot_quarantine` row, (ii) enumerates downstream customers via `stock_movements → invoice_items`, (iii) emits a `product.recall.opened` outbox event. Traceability is the enterprise litmus test in the parent prompt.

Plus one durability item plan.md flagged as ad-hoc:

- **D. Durable `check_stock_quant_drift` counter** — precondition for Phase 5 retirement. Write results to a `stock_quant_drift_runs` table with a nightly pg_cron trigger so the "14 clean runs" gate is auditable, not manual.

## Phase 3 — Execution order

### Step 1 — Phase E+ (variant-aware read paths) — highest urgency
Rationale: the moment anyone generates a variant matrix, every picker will show the un-transactable parent alongside its children. Data-integrity foot-gun; must land before Phase F expands importer surface.

1. Extend `src/hooks/useProducts.ts` (and `useProductsPaginated.ts`, `useBranchScopedProducts.ts`) with `excludeVariantParents?: boolean` (default `true`).
2. Audit and update every transactional picker to consume the default-filtered hook:
   - POS: `src/features/pos/` product lookup hook.
   - Invoice: `InvoiceLineRow` + siblings.
   - GRN wizard, sales-order line pickers, stock-adjustment line pickers.
3. `src/pages/Products.tsx` — collapse variants under parents; parent row aggregates children stock; opt out of the filter (`excludeVariantParents: false`).
4. Stock valuation / inventory reports (`InventoryValuationReport`, `StockReports`, `InventoryDashboard`) — exclude `is_variant_parent = true` from unit counts.
5. Barcode resolution audit: `rg "\.eq\(.id., " src/services/pos src/lib` to confirm no path assumes a matched `products.id` is transactable.
6. Extend `src/test/architecture/product-variants.test.ts` with picker-exclusion assertions (every listed hook must reference `is_variant_parent`).

### Step 2 — Audit additions A + B (single-session, small)
- Wire `interpretScan` into POS scan input hook.
- On GRN post, when `parseGs1` produced AI-17, upsert `stock_lots.expiry_date` (respect existing lot if present).

### Step 3 — Phase F (product import split)
1. **ADR 0073** — one importer per artefact, each idempotent, each emits business events on `business_event_outbox`.
2. Split `productImportConfig.ts` into six configs under `src/lib/importConfigs/`:
   - `productMasterImportConfig` (variant-aware: resolves axes via `product_variant_axes` by name; auto-creates unknown axis/value within business).
   - `productBarcodeImportConfig` (`product_identifiers`).
   - `productBatchImportConfig` (`stock_lots`).
   - `warehouseStockImportConfig` (opening `stock_quants` — **never** legacy `warehouse_stock`).
   - `priceListImportConfig` (`price_lists` + `price_list_items`).
   - `supplierPricelistImportConfig` (`vendor_pricelists`).
3. Retire old monolith or reduce it to a redirect.
4. Guard: `src/test/architecture/product-import-split.test.ts` — one config per artefact; no cross-artefact writes; variant importer resolves axes without dropping rows.

### Step 4 — Audit addition C (product recall)
1. Migration: `stock_quarantine_reasons` extension + `recall_lot(business_id, product_id, lot_number, reason)` PL/pgSQL RPC that quarantines remaining on-hand and returns downstream customer/invoice manifest.
2. Add "Recall this lot" action to `LotDetail.tsx` (permission-gated).
3. Emit `product.recall.opened` outbox event.
4. Guard: `recall-rpc.test.ts` (RPC present, event emitted, quarantine row written).

### Step 5 — Audit addition D + Phase 5 (retire `warehouse_stock`)
1. Create `stock_quant_drift_runs` table + nightly pg_cron writing `check_stock_quant_drift()` results.
2. Once 14 consecutive clean runs recorded, migrate remaining readers off `warehouse_stock`:
   - Replace helper in `src/lib/inventory/readOnHand.ts` to read `stock_quants`.
   - Update `useWarehouseStockTotals`, `useProcurementRecommendations`, `WarehouseStockPeekSheet`, all report pages, `POSTerminal`, `Products.tsx`, `Inventory.tsx`, `PhysicalCount`, `Forecast`, `InventoryReconciliationCard`.
3. Migration: drop `warehouse_stock` + `warehouse_stock_lots` (preflight snapshot into `stock_adjustment_backfill_log`).
4. **ADR 0074** — retirement rationale + drift-run evidence.

### Explicitly out of scope
- Sales-order line lot/serial pickers (SO doesn't move stock).
- Edit pages for sales returns & delivery notes (don't exist).
- Retro migration of "Size-in-name" legacy products → structured axes (needs product-owner sign-off).

## Technical notes
- Every new migration must include explicit `GRANT`s on public-schema tables (see `public-schema-grants` rule).
- Every new server function that mutates uses `requireSupabaseAuth`; recall RPC's admin-side quarantine write goes via `supabaseAdmin` **only after** role verification.
- Guards must land in the same session as the code they protect; no phase is "done" without its architecture test.
- Do not add new readers of `warehouse_stock` in any earlier step — Phase 5 has to be reachable.
