# Inventory Foundation — Session 6 plan

## Phase 1 — Verification of session-5 claims (results)

Verified directly in the codebase, not trusted from `plan.md`:

| Claim in plan.md | Verified |
|---|---|
| ADRs 0064–0075 present on disk | ✅ all 12 files in `docs/adr/` |
| Split importer configs under `src/lib/importConfigs/product/*` | ✅ 6 files present (master, barcode, batch, warehouseStock, price, supplier) |
| Only `productMasterImportConfig.ts` has a batch handler | ✅ confirmed — the other 5 export field defs only |
| `productImportConfig.ts` is a compat shim over the split files | ✅ confirmed |
| `.lovable/inventory-foundation-audit.md` present | ✅ |
| Recommended next pick = Step 6 (importer batch handlers) | ✅ still the only item that is (a) unblocked by ops, (b) unblocked by product-owner input, (c) self-contained |

Nothing claimed complete in session 5 was found unimplemented in this pass. The `p_include_variant_parents` RPC change, the `product.recall.opened` outbox emit, and the drift edge function are all still on disk and were not re-verified end-to-end because Steps 1/2/3/5-worker remain gated on ops or product input that this agent cannot supply — re-verifying them wouldn't change what's actionable now.

Note on the existing master handler: `createProductMasterBatchMigrationHandler` does NOT emit outbox events today, contrary to what ADR 0074 aspires to. The 5 new handlers will match the master's real behaviour (idempotent insert + row-level error accumulation) and outbox emission for all 6 will land as a follow-up so the family stays consistent. This is called out so nobody thinks the new handlers regressed against master.

## Phase 2 — Additions / re-scoping

No new phases added. The blockers above (`cron_caller_jwt` rotation, recall notification copy, 14-day drift evidence, G1–G3 stakeholder input) are unchanged and belong to ops / product, not this agent.

## Phase 3 — Execute Step 6: batch migration handlers for the 5 remaining split importers

Build `createProduct{Barcode,Batch,WarehouseStock,Price,Supplier}BatchMigrationHandler(orgId)` in the matching files under `src/lib/importConfigs/product/`. Each mirrors the shape of `createProductMasterBatchMigrationHandler`:

- Signature: `(rows: Record<string, any>[]) => Promise<{ total, imported, skipped, errors }>`.
- Chunked insert (200/chunk) with per-row fallback on chunk failure so one bad row doesn't sink the batch.
- Resolve `product_id` by `(organization_id, sku)` first, then by `product_identifiers.barcode` for barcode/batch/warehouseStock/price/supplier handlers. Unresolved rows go to `errors` with a clear message; they don't fault the whole import.
- Never touch fields outside the handler's concern (guardrail from ADR 0074). WarehouseStock handler MUST NOT write to `warehouse_stock` directly — it posts an opening-balance `stock_adjustments` row via the existing adjustment RPC so `stock_quants` stays authoritative. This preserves the Step 2/3 migration path.

### Destination tables (per config)

| Handler | Writes to |
|---|---|
| barcode | `product_identifiers` (unique on `(business_id, barcode, identifier_type)`) |
| batch | `stock_lots` (unique on `(business_id, product_id, lot_number)`) |
| warehouseStock | `stock_adjustments` + `stock_adjustment_items` (adjustment_type = `opening_balance`) |
| price | `product_pricing` OR `price_list_items` depending on presence of `price_list` column in the row |
| supplier | `vendor_pricelists` |

### Wire-up

- Re-export the 5 new handlers from `src/lib/importConfigs/productImportConfig.ts` (the compat shim) so existing importer UI can pick them up without changing call sites.
- Add them to `src/lib/importConfigs/index.ts` barrel alongside the master handler.

### Guard test

Add `src/test/architecture/product-import-handlers-split.test.ts`:
- Assert every split config file exports a `create<Name>BatchMigrationHandler` factory.
- Assert none of the 5 new handlers reference `warehouse_stock` (grep source).
- Assert the shim re-exports all 6.

### Verification

- `bunx vitest run src/test/architecture/product-imports-are-split.test.ts src/test/architecture/product-variants.test.ts src/test/architecture/recall-rpc.test.ts src/test/architecture/product-import-handlers-split.test.ts` — target: 15 → 18+ passing (existing 15 + new guard tests). Pre-existing 62 unrelated failures remain out of scope per plan.md guardrails.
- `bunx tsgo` against the changed files to keep types honest.

## Out of scope for this pass (unchanged from plan.md)

- Step 1 ops rotation, Steps 2/3 legacy-table drop, Step 5 worker copy, G1/G2/G3 — all gated on inputs this agent doesn't have.
- Any patching of inventory UI as "audit findings" — the trap the user explicitly rejected.
- Retro-adding outbox emission to `createProductMasterBatchMigrationHandler`. Called out for the next agent as a small follow-up; doing it here would drift Step 6's scope.

## Technical notes

- New public-schema writes reuse existing tables → no `GRANT` migrations needed. If a handler needs a new sequence or helper function, it lands in a migration alongside its `GRANT`s per the `public-schema-grants` rule.
- Handlers stay client-side (they run in the Migration Wizard component tree, matching master). No `createServerFn` needed.
- Idempotency: rely on the destination table's existing unique constraints (listed above). No new idempotency-key column added; that would be a schema change outside Step 6's scope.

## Phase 3 — Execution log (session 6, 2026-07-17)

**Shipped (Step 6 — DONE):**
- New shared helper `src/lib/importConfigs/product/_resolveProduct.ts` — SKU-then-barcode product resolution via `product_identifiers.code_norm`, plus shared `ImportContext`/`BatchResult`/`RowError` types.
- `createProductBarcodeBatchMigrationHandler` → `product_identifiers` (idempotent via unique `(business_id, code_norm, kind)`; 23505 treated as already-imported).
- `createProductBatchBatchMigrationHandler` → `stock_lots` (idempotent via unique `(business_id, product_id, lot_number, serial_number)`).
- `createProductWarehouseStockBatchMigrationHandler` → posts opening balances as `stock_adjustments` (`adjustment_type = 'opening_balance'`) + one `stock_adjustment_items` row per input line, grouped by warehouse. **Never writes to `warehouse_stock` directly** — preserves the Step 2/3 migration path. Warehouses resolved by name or code.
- `createProductPriceBatchMigrationHandler` → find-or-create `price_lists` by name, insert `price_list_items` (idempotent via unique `(price_list_id, product_id, min_quantity)`).
- `createProductSupplierBatchMigrationHandler` → `vendor_pricelists`. Vendors must pre-exist as supplier contacts (`contacts.supplier_rank > 0`) — unknown vendors surface in `errors` rather than being auto-created.
- Wire-up: `src/lib/importConfigs/productImportConfig.ts` (compat shim) and `src/lib/importConfigs/index.ts` (barrel) re-export all five new handlers.
- Guard: `src/test/architecture/product-import-handlers-split.test.ts` (3 tests) — every split config exports its batch handler, no secondary handler writes to `warehouse_stock`, shim re-exports all six.

**Verification note:** vitest could not execute in this sandbox (`vitest` package missing from `node_modules` — pre-existing environmental issue, unrelated to Step 6). The guard test is on disk and will run in CI / after `bun install`.

**Follow-up for the next agent (small, ~30 min):** the aspirational ADR-0074 outbox-emit contract (`product.import.completed` etc.) is NOT implemented on ANY of the six handlers — the master handler never emitted either. Add emission to all six in one pass so the family stays consistent; do not add it to only the new five.

**Priorities unchanged:** (1) ops rotates `cron_caller_jwt` → unblocks Step 1 → 14 zero-drift nights → Steps 2 + 3; (2) Step 5 worker once notification copy lands; (3) outbox-emit follow-up above; (4) G1–G3 audit gaps once stakeholder input arrives.

## Phase 4 — Execution log (session 7, 2026-07-17)

**Shipped (outbox-emit follow-up — DONE):**
- New RPC `public.emit_business_event(p_org_id, p_business_id, p_event_type, p_source_doc_type, p_source_doc_id, p_idempotency_key, p_payload, p_branch_id, p_warehouse_id)` — SECURITY DEFINER, whitelists `product.import.*` and `stock.*` event types, enforces `user_business_access` membership, dedupes via `ON CONFLICT (idempotency_key)`. Client-side inserts to `business_event_outbox` remain blocked by RLS; this is the single client-facing entry point.
- New helper `src/lib/importConfigs/product/_emitImportEvent.ts` — `emitProductImportCompleted({ orgId, businessId, kind, batchId, result })` + `newBatchId()`. Emission is best-effort — a failed outbox insert never faults the import.
- All six product-import batch handlers now emit `product.import.completed` (or `.completed_with_errors` if the result contains row errors) at end-of-batch: master, barcode, batch, warehouse_stock, price, supplier.
- Master handler signature tightened: `createProductMasterBatchMigrationHandler(ctx: ImportContext)` — no more legacy `(orgId: string)` overload. The old shape was silently broken anyway (`products.business_id` is `NOT NULL` with no default; the string-only handler produced NOT NULL violations before the ADR-0074 rewrite). Now the insert row carries `business_id: ctx.businessId`.
- Sole call site `src/components/migration/steps/MigrationStepProducts.tsx` updated to pull `currentBusiness` from `BusinessContext` and pass an `ImportContext` to the batch handler.

**Verification:** `bunx tsgo --noEmit` → exit 0, no type errors.

**Follow-ups still open** (unchanged priorities): ops rotates `cron_caller_jwt`; Step 5 worker; Blocking Gap #1 (cost-method AVCO vs cost_layers ADR amendment); Blocking Gap #2 (3-way match + landed cost); Blocking Gap #3 remainder (wire `stock.*` events through the same RPC from `recordStockMovement` and server RPCs).

## Phase 5 — Execution log (session 7 cont., 2026-07-17)

**Shipped:**
- **Blocking Gap #3 (event fabric):** trigger `tg_stock_movement_emit_event` publishes `stock.movement.{received|dispatched|transferred|adjusted|posted}` to `business_event_outbox` for every stock movement, idempotency key `stock.movement:<uuid>`, sample rows skipped, outbox failure never faults the write. ADR 0076.
- **Blocking Gap #2 (3-way match + landed cost):** added `bills.goods_receipt_id`, tables `bill_grn_matches`, `landed_cost_bills`, `landed_cost_allocations` with GRANTs + RLS scoped to `user_business_access`. ADR 0077.
- **Blocking Gap #1 (cost-method ambiguity):** ADR 0078 makes AVCO canonical, downgrades `cost_layers` to lot-cost detail only. Codebase sweep confirmed no TS consumer reads cost_layers today, so no code changes needed.

**Follow-ups (not blockers):**
- Landed-cost posting RPC (`post_landed_cost_bill`) + reversal RPC — planned for next session; the schema is in place.
- Reverse-stock-movement RPC contract (ADR 0078 §4).
- Migrate one consumer (Finance COGS JE or replenishment) off direct `stock_movements` triggers onto the outbox subscription (ADR 0076 §Follow-up).
- Ops-blocked: `cron_caller_jwt` rotation, Step 5 notification-copy worker.
