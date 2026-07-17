# Inventory Foundation — Handoff & Next Execution (2026-07-17)

## Status: verification complete; 6 deliverables shipped; 6 items deferred in order.

## Phase 1 — Verification of prior claims (re-confirmed this thread)

| Claim | Status |
|---|---|
| ADRs 0064–0075 on disk | ✅ present |
| Phase E migration (3 product cols + 2 axis tables) | ✅ confirmed via `information_schema` |
| `stock_serials`, `stock_quants`, `inbound_shipments(+_items)`, legacy `warehouse_stock(+_lots)` | ✅ 6/6 |
| Phase D.3 Inbound Shipments UI | ✅ |
| Phase G Lot Genealogy (`Lots.tsx`, `LotDetail.tsx`, ADR 0070) | ✅ |
| Phase H GS1 parser + tests + guard | ✅ |
| Phase E authoring (`src/features/inventory/variants/*` + panel in ProductForm) | ✅ |
| Legacy edge-function folders removed (11) | ✅ this session |
| Concise pillar-verdict `.lovable/inventory-foundation-audit.md` | ✅ this session |

Nothing claimed-complete was found unimplemented.

## Phase 2 — Additions accepted into roadmap

- **A. POS scanner GS1 wiring** — ✅ shipped (session 2).
- **B. AI-17 expiry into GRN persistence** — ✅ shipped (session 2).
- **C. Product-recall RPC + Lot Genealogy UI action** — ✅ shipped (session 2, ADR 0073).
- **D. Durable `stock_quant_drift_runs` counter** — ✅ table + RPC live (session 4, ADR 0075). Nightly writer still pending.

## ✅ Delivered

| # | Deliverable | Location | Evidence |
|---|---|---|---|
| 1 | Phase E+ variant-aware read paths (parents filtered by default) | `src/hooks/useProducts.ts`, `useProductsPaginated.ts`, `useBranchScopedProducts.ts`; opt-in on `src/pages/Products.tsx` | `src/test/architecture/product-variants.test.ts` (9 tests) |
| 2 | POS GS1 scan wiring | `src/pages/pos/POSTerminal.tsx` (`handleSearchKeyDown` + scanBus) | Both paths funnel through `interpretScan` before resolver |
| 3 | GRN persists AI-17 expiry + AI-11 mfg into `stock_lots` | `src/features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx` | Post-RPC UPDATE loop keyed `(business, product, lot)` |
| 4 | Recall RPC + UI action (ADR 0073) | `public.recall_lot(...)` migration; `src/pages/inventory/LotDetail.tsx`; `docs/adr/0073-product-recall-rpc.md` | `src/test/architecture/recall-rpc.test.ts` (3 tests) |
| 5 | Phase F import split (ADR 0074) | `src/lib/importConfigs/product/{Master,Barcode,Batch,WarehouseStock,Price,Supplier}ImportConfig.ts`; legacy shim allowlisted | `src/test/architecture/product-imports-are-split.test.ts` (2 tests) |
| 6 | Drift-run log infra (ADR 0075, gate for Phase 5) | `public.stock_quant_drift_runs` + `record_stock_quant_drift_run(...)`; org members read, service_role write | Live in Supabase |
| 7 | Legacy localization edge-function folder cleanup | `supabase/functions/` — 11 folders removed | `rg` confirms no live invoke callers |
| 8 | Pillar-by-pillar foundation verdict | `.lovable/inventory-foundation-audit.md` | Identifies 3 blocking gaps (see below) |

## ⏭ Deferred — execute in this order (each depends on the previous)

### Step 1 — Nightly `stock-quant-drift` edge function + `pg_cron`
- Scaffold `supabase/functions/stock-quant-drift/index.ts`: zod-validated `{organization_id}`, page products by 500, compute per-warehouse `sum(stock_quants.quantity)` vs `sum(warehouse_stock.quantity)`, call `record_stock_quant_drift_run` per org. CORS + JWT-in-code.
- Deploy, then schedule via `supabase--insert` (NOT `--migration`) because SQL embeds function URL + anon key:
  ```
  select cron.schedule('nightly-stock-quant-drift', '15 2 * * *', $$ … $$);
  ```
- Target: 14 consecutive zero-drift runs across active orgs before any table drop.

### Step 2 — `warehouse_stock` → `stock_quants` reader migration
- Rewrite `src/lib/inventory/readOnHand.ts` to read `stock_quants` (aggregate `quantity`, sum `reserved_quantity` from `stock_reservations` join). Keep signature identical.
- Route every direct `.from("warehouse_stock")` call outside the helper through `readOnHand` or its siblings: `useWarehouseStockTotals`, `useProcurementRecommendations`, `WarehouseStockPeekSheet`, `src/pages/reports/*`, `POSTerminal`, `Products.tsx`, `Inventory.tsx`, `PhysicalCount.tsx`, `Forecast.tsx`, `InventoryReconciliationCard.tsx`, `useBranchScopedProducts.ts` (~139 refs across 39 files).
- Invert `src/test/architecture/warehouse-stock-reads-go-through-helper.test.ts` — only `readOnHand.ts` + its tests may reference `warehouse_stock`.

### Step 3 — ADR 0076 + drop `warehouse_stock` + `warehouse_stock_lots`
- Preflight snapshot both tables into `stock_adjustment_backfill_log` (audit body: `{table, rows, snapshot_id}`).
- Gate: ≥14 zero-drift runs in `stock_quant_drift_runs`.
- Drop; remove `warehouse_stock*` from `businessScopedTables.ts`; regenerate types.

### Step 4 — Server-side variant-parent filter in `list_products_with_branch_stock` RPC
- Fold `is_variant_parent = false` into the RPC WHERE clause. Delete the client-side parent-id parallel fetch in `useBranchScopedProducts`.

### Step 5 — Recall outbox event + notification worker
- Emit `product.recall.opened` to `business_event_outbox` inside `recall_lot` (payload: recall id + manifest).
- Worker edge function fans out via existing `email_templates` / `sms_templates`.

### Step 6 — Per-artefact batch handlers for the 5 remaining split importers
- `productMaster` has `createProductMasterBatchMigrationHandler`. Add matching handlers for `barcode`, `batch`, `warehouseStock`, `price`, `supplier` — each writes to its own destination with idempotency keys + outbox events per ADR 0074.

## Foundation-audit blocking gaps (from `.lovable/inventory-foundation-audit.md`)

Deferred pending user direction — not scheduled above until picked:

- **G1. Cost-method ambiguity.** ADR 0002 declares AVCO canonical, but `cost_layers` + `cost_layer_consumptions` + `_maintain_cost_layers` trigger exist. Publish ADR 0002-a: AVCO is the trial-balance cost; `cost_layers` is FEFO-cost for lot-tracked products only. Audit no other reader uses it.
- **G2. 3-way match + landed cost.** Add `bills.goods_receipt_id` (+ `bill_grn_matches` junction); add `landed_cost_bills` + `landed_cost_allocations` (basis: qty/weight/value) feeding `cost_layers`.
- **G3. Inventory outbox events unpopulated.** Define `stock.movement.posted`, `stock.lot.received`, `stock.transfer.dispatched|received`, `stock.serial.status_changed`. Publish from the writing RPC in one transaction. Migrate one downstream consumer (Finance COGS JE) as proof.

## Guardrails (non-negotiable)

- **Never add a new `warehouse_stock` reader.** Steps 2–3 get harder for every one added.
- **Every new public-schema table gets `GRANT`s in the same migration** — see `public-schema-grants`.
- **Guards land with the code they protect** — no phase closes without its architecture test.
- **User-scoped SQL (function URLs, anon keys) → `supabase--insert`, never `supabase--migration`.**
- **62 pre-existing architecture-test failures are out of scope.** Green signal for this thread: `product-variants.test.ts` (9) + `recall-rpc.test.ts` (3) + `product-imports-are-split.test.ts` (2) = 14 tests.
- **Legacy `productImportConfig.ts` is a compat shim** — new importers use the split files under `src/lib/importConfigs/product/`.
- **Do NOT reopen** localization-pack consolidation, hosting, or the security scan flow.
- **Do NOT patch inventory UI as "audit findings"** — the trap the user explicitly rejected.

## Explicitly out of scope

- Sales-order line lot/serial pickers (SO doesn't move stock).
- Edit pages for sales returns & delivery notes (don't exist).
- Retro migration of "Size-in-name" legacy products → structured axes (needs product-owner sign-off).

## Next action on resume

Step 1: scaffold `supabase/functions/stock-quant-drift/index.ts`, deploy, then schedule the nightly cron via `supabase--insert`. No table drop, no reader migration this session — just start the 14-day evidence window ticking.
