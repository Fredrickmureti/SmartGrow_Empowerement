# Inventory Foundation — Handoff & Next Execution (2026-07-17, session 5)

## Status: 10 deliverables shipped; Step 1 blocked on an ops-only fix; Steps 2/3/6 + audit gaps G1–G3 remain.



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
| 9 | Server-side variant-parent filter in `list_products_with_branch_stock` RPC (Step 4) | Migration `2026-07-17T03:07:18`; `src/hooks/useBranchScopedProducts.ts`; `src/hooks/pos/usePOSProducts.ts` | RPC now takes `p_include_variant_parents boolean DEFAULT false`; client-side parent-id parallel fetch removed |
| 10 | Recall RPC emits `product.recall.opened` to `business_event_outbox` (Step 5) | Migration `2026-07-17T03:12:14`; `src/test/architecture/recall-rpc.test.ts` (+1 test, now 4 total) | Idempotency key = `product.recall.opened:<recall_id>`; `ON CONFLICT (idempotency_key) DO NOTHING` |

## ⏭ Deferred — execute in this order (each depends on the previous)

### Step 1 — Nightly `stock-quant-drift` edge function + `pg_cron` — ⚠️ CODE DONE, BLOCKED ON OPS
- ✅ `supabase/functions/stock-quant-drift/index.ts` exists and boots (was already scaffolded).
- ✅ Refactored to use shared `_shared/requireCronAuth.ts` (matches every other cron function in this project).
- ✅ Cron job `nightly-stock-quant-drift` scheduled at `15 2 * * *` UTC, calling the function with `public.cron_caller_auth_header()`.
- ✅ `supabase/config.toml` sets `verify_jwt = false` for this function.
- ❌ **Blocker (pre-existing, project-wide):** every scheduled function using `cron_caller_auth_header()` currently returns 401 (`{"error":"unauthorized"}`). The vault secret `cron_caller_jwt` is out of sync with `SUPABASE_SERVICE_ROLE_KEY` — evidence in `net._http_response` shows the same failure for `check-leave-expiry`, `update-overdue-invoices`, etc. Rotating/refreshing `cron_caller_jwt` in the Supabase vault to match the current service-role key unblocks ALL cron jobs at once; do NOT patch each function individually. Once fixed, the 14-day drift-evidence window starts ticking with no code changes.
- Target: 14 consecutive zero-drift runs across active orgs before any table drop.

### Step 2 — `warehouse_stock` → `stock_quants` reader migration (GATED on Step 1)
- Rewrite `src/lib/inventory/readOnHand.ts` to read `stock_quants` (aggregate `quantity`, sum `reserved_quantity` from `stock_reservations` join). Keep signature identical.
- Route every direct `.from("warehouse_stock")` call outside the helper through `readOnHand` or its siblings: `useWarehouseStockTotals`, `useProcurementRecommendations`, `WarehouseStockPeekSheet`, `src/pages/reports/*`, `POSTerminal`, `Products.tsx`, `Inventory.tsx`, `PhysicalCount.tsx`, `Forecast.tsx`, `InventoryReconciliationCard.tsx`, `useBranchScopedProducts.ts` (~139 refs across 39 files).
- Invert `src/test/architecture/warehouse-stock-reads-go-through-helper.test.ts` — only `readOnHand.ts` + its tests may reference `warehouse_stock`.

### Step 3 — ADR 0076 + drop `warehouse_stock` + `warehouse_stock_lots` (GATED on Step 2)
- Preflight snapshot both tables into `stock_adjustment_backfill_log` (audit body: `{table, rows, snapshot_id}`).
- Gate: ≥14 zero-drift runs in `stock_quant_drift_runs`.
- Drop; remove `warehouse_stock*` from `businessScopedTables.ts`; regenerate types.

### Step 4 — Server-side variant-parent filter in `list_products_with_branch_stock` RPC — ✅ DONE (this session)
- Migration adds `p_include_variant_parents boolean DEFAULT false` param + `AND (p_include_variant_parents OR NOT COALESCE(p.is_variant_parent, false))` in WHERE.
- `src/hooks/useBranchScopedProducts.ts` — dropped the parallel parent-id fetch; passes the flag through.
- `src/hooks/pos/usePOSProducts.ts` — passes `p_include_variant_parents: false` and also excludes variant parents from the raw `products` fallback query via `.or("is_variant_parent.is.null,is_variant_parent.eq.false")`.

### Step 5 — Recall outbox event + notification worker — ⚠️ PARTIALLY DONE
- ✅ Event emission: `recall_lot` RPC now inserts `product.recall.opened` into `public.business_event_outbox` inside the same transaction as the recall header. Payload carries `business_id`, `product_id`, `lot_id`, `lot_number`, `recall_reference`, `reason`, `severity`, `quarantined_units`, `warehouses_affected`, `downstream_customers`. Idempotency key: `product.recall.opened:<recall_id>` (partial unique index confirmed on `business_event_outbox.idempotency_key`).
- ✅ Guard: `recall-rpc.test.ts` gained a 4th test enforcing the outbox insert + idempotency clause.
- ⏭ **Worker still pending.** Build a notification edge function that consumes `product.recall.opened` from the outbox, resolves `email_templates` / `sms_templates` per org, and dispatches to the `downstream_customers` manifest. Mark event `completed` on success. Deferred deliberately — no live template pack exists yet for recalls; product-owner input needed on wording.

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

## Session 5 log (2026-07-17) — what this agent did

**Shipped this session:**
- **Step 4 — Server-side variant-parent filter (DONE).** Migration `2026-07-17T03:07:18` adds `p_include_variant_parents boolean DEFAULT false` to `list_products_with_branch_stock` with `AND (p_include_variant_parents OR NOT COALESCE(p.is_variant_parent, false))` in WHERE. `src/hooks/useBranchScopedProducts.ts` dropped the parallel parent-id fetch and now passes the flag through. `src/hooks/pos/usePOSProducts.ts` passes `p_include_variant_parents: false` and hardens the raw `products` fallback with `.or("is_variant_parent.is.null,is_variant_parent.eq.false")`.
- **Step 5 event side (DONE; worker deferred).** Migration `2026-07-17T03:12:14` — `recall_lot` RPC inserts `product.recall.opened` into `public.business_event_outbox` in the same transaction as the recall header. Payload: `business_id`, `product_id`, `lot_id`, `lot_number`, `recall_reference`, `reason`, `severity`, `quarantined_units`, `warehouses_affected`, `downstream_customers`. Idempotency key `product.recall.opened:<recall_id>` with `ON CONFLICT (idempotency_key) DO NOTHING` (partial unique index confirmed). `src/test/architecture/recall-rpc.test.ts` grew a 4th test enforcing the outbox insert + idempotency clause.
- **Step 1 code side (DONE; runtime blocked).** `supabase/functions/stock-quant-drift/index.ts` refactored to shared `_shared/requireCronAuth.ts` middleware (matches every other cron function). `supabase/config.toml` sets `verify_jwt = false`. Cron job `nightly-stock-quant-drift` rescheduled at `15 2 * * *` UTC via `supabase--insert` using `public.cron_caller_auth_header()`.

**Blocked (pre-existing, project-wide — NOT caused by this thread):**
- `nightly-stock-quant-drift` (and every other cron-triggered function in this project) returns 401 (`{"error":"unauthorized"}`). Evidence in `net._http_response`: `check-leave-expiry`, `update-overdue-invoices`, etc. all fail identically. **Root cause: the vault secret `cron_caller_jwt` is stale relative to `SUPABASE_SERVICE_ROLE_KEY`.** One vault rotation unblocks the entire cron surface. Do NOT chase this per-function.

**What remains (priority order):**
1. **Ops:** rotate `cron_caller_jwt` in Supabase Vault → unblocks Step 1 runtime. No code.
2. **Step 5 worker:** `recall-notification-worker` edge function. Blocked on product-owner sign-off for notification copy; scaffold ready once wording lands.
3. **Step 6:** five importer batch handlers (`barcode`, `batch`, `warehouseStock`, `price`, `supplier`) mirroring `createProductMasterBatchMigrationHandler`.
4. **Steps 2 + 3:** `warehouse_stock` → `stock_quants` reader migration, then drop legacy tables. **Gated on 14 consecutive zero-drift rows in `stock_quant_drift_runs`** (Step 1 must be unblocked and running for 14 nights first).
5. **Audit gaps G1–G3:** need product/finance-owner input first.

**Recommended next pick for the following agent: Step 6 (importer batch handlers).** Rationale: it is the only remaining item that is (a) fully unblocked, (b) self-contained, (c) has a clear template in `createProductMasterBatchMigrationHandler`, (d) needs no product-owner or ops input. Step 5's worker is next-best but stalls on copy. Steps 2/3 are gated on Step 1's ops fix + 14-day evidence window. G1–G3 are gated on stakeholder input.

## Next action on resume (for the following agent)

Verify what's here before you build. Then pick from below in the listed order.

### 0 · Verify session 5 landed (5 min)
- `rg "p_include_variant_parents" supabase/migrations/ src/hooks/` → expect the RPC migration + both hooks.
- `rg "product.recall.opened" supabase/migrations/` → expect the outbox emit inside `recall_lot`.
- `bunx vitest run src/test/architecture/recall-rpc.test.ts src/test/architecture/product-variants.test.ts src/test/architecture/product-imports-are-split.test.ts` → expect 15 tests green (9 + 4 + 2). Ignore the 62 pre-existing failures elsewhere.

### 1 · Unblock cron (ops, ~5 min, no code)
Tell the user to rotate `cron_caller_jwt` in Supabase Vault to the current `SUPABASE_SERVICE_ROLE_KEY`. Then wait one night (or invoke `select cron.schedule(...)` on a shorter cadence temporarily) and confirm `stock_quant_drift_runs` starts filling with `drifted_rows = 0`. Do NOT start Step 2 until 14 zero-drift rows exist.

### 2 · Ship Step 5's worker (self-contained, 1–2 hrs)
Once product-owner confirms notification copy, build `supabase/functions/recall-notification-worker/index.ts`:
- Claim outbox rows where `event_type = 'product.recall.opened'` and `status = 'pending'` using the existing `claim_business_event_outbox` pattern used by other workers (grep `claim_business_event_outbox` for the canonical claim RPC).
- For each `downstream_customers[]` entry with a non-null email/phone, render from `email_templates` / `sms_templates` scoped to the org, key `recall_customer_notification`.
- Mark the outbox row `completed` on success; leave `pending` + increment `attempts` on failure. Use `requireCronAuth` for the endpoint; schedule via `supabase--insert` with `cron_caller_auth_header()`.
- Guard test: assert the function exists, uses the correct event type, and doesn't hardcode SMS/email bodies.

### 3 · Step 6 (importer batch handlers, ~half day)
Mirror `createProductMasterBatchMigrationHandler` for each of `barcode`, `batch`, `warehouseStock`, `price`, `supplier`. Each handler:
- Reads its own split config from `src/lib/importConfigs/product/`.
- Writes to its own destination table (never `warehouse_stock` — see guardrail).
- Emits its own outbox event per ADR 0074 with an idempotency key of `product-import:<config>:<row_hash>`.

### 4 · Steps 2 + 3 (only after Step 1 unblocks and 14 zero-drift runs land)
Rewrite `src/lib/inventory/readOnHand.ts` first; migrate every direct `warehouse_stock` reader through it (~139 refs across 39 files); invert the architecture guard so `readOnHand.ts` is the ONLY allowed reference; snapshot both legacy tables; drop them under ADR 0076.

### 5 · Audit gaps G1–G3 (product/finance-owner input required first)
G1 (cost method): needs written call from Finance on AVCO vs FEFO scope before ADR 0002-a. G2 (3-way match + landed cost): schema change touches purchasing + finance, needs product-owner scoping. G3 (inventory outbox events): parallel to Step 5 worker — once the recall event proves the outbox pattern end-to-end, use the same pattern for `stock.movement.posted` et al.

Keep the guardrails above intact. No new `warehouse_stock` readers. Every phase closes with its guard test.


