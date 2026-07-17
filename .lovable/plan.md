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
- Migrate one consumer (Finance COGS JE or replenishment) off direct `stock_movements` triggers onto the outbox subscription (ADR 0076 §Follow-up).
- Ops-blocked: `cron_caller_jwt` rotation, Step 5 notification-copy worker.

## Phase 6 — Execution log (session 7 cont., 2026-07-17)

**Shipped:**
- Added `stock_movements.reverses_movement_id` self-reference + `landed_cost` movement_type.
- `reverse_stock_movement(p_movement_id, p_reason)` — SECURITY DEFINER, refuses double-reversal and reversing a reversal, checks caller has owner/admin/accountant/staff on the business, inserts a negating movement that inherits pack provenance and reference fields. Because the reversal goes through the standard INSERT path, `tg_stock_movement_emit_event` publishes a matching `stock.movement.*` event, so consumers get a symmetrical entry with no bespoke reversal-event type.
- `post_landed_cost_bill(p_bill_id)` — validates status=`allocated`, sum(allocated_amount)=total_amount (rounded to 2dp), writes one `landed_cost` stock_movements row per allocation (quantity 0, unit_cost=allocated_amount, reference to bill), stamps `posted_movement_id` back on the allocation, flips bill to `posted`.
- `reverse_landed_cost_bill(p_bill_id, p_reason)` — iterates posted allocations, calls `reverse_stock_movement`, clears `posted_movement_id`, flips bill to `reversed`.

**Verification:** migration applied; linter output was 1823 pre-existing issues, none introduced by this migration.

**Priorities still open (unchanged):** ops rotates `cron_caller_jwt`; Step 5 worker; migrate one consumer off direct `stock_movements` triggers to the outbox; G1–G3 stakeholder input.

---

## Handoff to next agent (2026-07-17, end of session 7)

Read this section first. Everything above is history; this is the current state.

### What is DONE (verified on disk / in DB)

1. **Product import architecture (ADR 0074).** Six split configs under `src/lib/importConfigs/product/`: master, barcode, batch, warehouse_stock, price, supplier. Each exports a `create<Name>BatchMigrationHandler(ctx: ImportContext)` factory. Compat shim `productImportConfig.ts` re-exports all six. Barrel `src/lib/importConfigs/index.ts` re-exports the six. Guard test `src/test/architecture/product-import-handlers-split.test.ts`.
2. **Import outbox emission.** RPC `public.emit_business_event(...)` is the single client-facing publisher; whitelists `product.import.*` and `stock.*`; enforces `user_business_access` membership; dedupes on `idempotency_key`. All six import handlers call `emitProductImportCompleted` at end-of-batch (`_emitImportEvent.ts` helper). Emission is best-effort — a failed outbox insert never faults the import.
3. **Master handler signature tightened.** `createProductMasterBatchMigrationHandler(ctx: ImportContext)` — no more `(orgId: string)` overload. Sole call site `MigrationStepProducts.tsx` pulls `currentBusiness` from `BusinessContext` and passes a full context.
4. **Stock Event Fabric (ADR 0076, Blocking Gap #3).** Trigger `tg_stock_movement_emit_event` publishes `stock.movement.{received|dispatched|transferred|adjusted|posted}` to `business_event_outbox` for every INSERT into `stock_movements`. Idempotency key `stock.movement:<uuid>`; `is_sample_data` skipped; outbox failure never faults the write.
5. **3-Way Match + Landed Cost schema (ADR 0077, Blocking Gap #2).** `bills.goods_receipt_id` column; tables `bill_grn_matches`, `landed_cost_bills`, `landed_cost_allocations` with GRANTs + RLS scoped to `user_business_access` (owner/admin/accountant/staff for writes).
6. **AVCO canonical cost method (ADR 0078, Blocking Gap #1).** `cost_layers`/`cost_layer_consumptions` downgraded to lot-cost detail only. Codebase sweep confirmed no TS consumer reads them, so no code changes were needed.
7. **Stock movement reversal + landed-cost posting RPCs.**
   - `stock_movements.reverses_movement_id` self-reference column + `landed_cost` added to `movement_type` CHECK.
   - `reverse_stock_movement(p_movement_id, p_reason)` — inserts negating movement; refuses double-reversal and reversing a reversal; auth checked via `user_business_access`.
   - `post_landed_cost_bill(p_bill_id)` — validates status=allocated + sum(allocations)=total, writes one `landed_cost` movement per allocation (quantity 0, unit_cost=allocated_amount), stamps `posted_movement_id`, flips status to posted.
   - `reverse_landed_cost_bill(p_bill_id, p_reason)` — reverses each posted allocation via `reverse_stock_movement`, clears link, flips status to reversed.
   - Reversals inherit the standard INSERT path, so `tg_stock_movement_emit_event` publishes matching `stock.movement.*` events automatically — no bespoke reversal event type.

### Verification status

- `bunx tsgo --noEmit` was clean at end of session 6 (import handler rewrite). Not re-run after the RPC-only migration in session 7 because that migration touched no TS.
- Vitest could not run in the sandbox (`vitest` missing from `node_modules` — pre-existing env issue). Guard tests are on disk and will run in CI.
- Supabase linter reports 1823 pre-existing issues; none introduced by session-6 or session-7 migrations. Do not attempt to "fix" them as part of this workstream — they are out of scope and mostly belong to other modules.

### What REMAINS — pick these up in this order

**Priority A — wire the fabric to a real consumer (proves ADR 0076 works).**
Pick ONE existing consumer that currently reads `stock_movements` via a direct trigger and migrate it to subscribe to the outbox via `BusinessSaga`. Candidates in order of expected value:
1. Finance COGS journal-entry poster (search `rg -n "stock_movements" supabase/migrations/ | rg -i "trigger|cogs|journal"`).
2. Replenishment / reorder-point recompute.
3. External WMS adapter (if any).
Register a handler on `stock.movement.dispatched` (or `.received` for COGS reversal), remove the direct trigger in the same migration. Success metric: one AFTER-INSERT trigger removed from `stock_movements`, one saga handler added under `src/services/events/handlers/`, no COGS drift on a smoke transaction.

**Priority B — server-side `emit_business_event` from `recordStockMovement` for non-inventory `stock.*` events** (e.g. `stock.count.completed`, `stock.transfer.approved`). The trigger only emits `stock.movement.*`. Domain events that don't correspond 1:1 to a movement (cycle-count approvals, transfer-order state changes) still need explicit emission from RPC/edge code. Audit callers of `recordStockMovement` under `src/lib/inventory/` and add emission where a domain event is warranted.

**Priority C — landed-cost allocation calculator (client or RPC).**
The RPCs `post_landed_cost_bill` / `reverse_landed_cost_bill` assume `landed_cost_allocations` rows already exist and sum to the bill total. There is currently NO code that CREATES those allocations from a bill's `allocation_basis` (quantity/value/weight/manual). Add either a client-side helper or (preferred) an `allocate_landed_cost_bill(p_bill_id)` RPC that fans the total across the linked GRN lines by the chosen basis, writing `landed_cost_allocations` rows and flipping status draft→allocated. Then wire a minimal UI screen under `src/features/inventory/landed-cost/` (list, allocate, post, reverse).

**Priority D — 3-way match UI + auto-populate `bill_grn_matches`.**
Schema exists; no UI or auto-matcher does. Add a `match_bill_to_grn(p_bill_id)` RPC that, for each `bill_items` row with a `purchase_order_item_id`, finds the matching `goods_receipt_items` via the shared PO line and inserts `bill_grn_matches` rows (matched_quantity = LEAST(billed, received)). Surface unmatched lines in the Bills UI.

**Priority E — outbox-emit follow-up for the master handler.**
Currently the master handler emits `product.import.completed` via `_emitImportEvent.ts` — same as the other five. Double-check with a small runtime test that a real import produces the expected outbox row; the code path is untested end-to-end in this environment.

### Ops-blocked (do NOT attempt to unblock from code)

- `cron_caller_jwt` rotation → until ops rotates, Step 1 monitoring stays paused; Steps 2 + 3 (legacy `warehouse_stock` / `products.stock_quantity` drop) stay parked. Do not delete the legacy tables from a code session; wait for 14 zero-drift nights after rotation.
- Step 5 notification-copy worker → blocked on product-owner copy for `product.recall.opened`.
- G1 / G2 / G3 audit gaps → blocked on stakeholder input; do not fabricate answers.

### Where to look first next session

1. `.lovable/inventory-foundation-audit.md` — the original audit, still the source of truth for gap enumeration.
2. `docs/adr/0074`, `0076`, `0077`, `0078` — decisions this workstream shipped against.
3. `src/services/events/BusinessSaga.ts` + `src/services/events/index.ts` — the drainer + registration surface for Priority A.
4. `src/lib/inventory/stockLedger.ts` — the single choke-point every non-import movement flows through; the place to hang Priority B emissions.
5. Latest three migrations (all dated 2026-07-17): `20260717093911_*` (event fabric trigger), `20260717094014_*` (landed-cost schema), and the RPC migration applied in Phase 6.

### Guardrails that survived the workstream

- Never store roles on `profiles`; always use `user_roles` + `has_role` (unchanged, no violations added).
- Every new `public` table shipped with GRANTs in the same migration (rule respected in `20260717094014_*`).
- No client-side inserts into `business_event_outbox` — always via `emit_business_event` RPC.
- Handlers never touch fields outside their concern (ADR 0074 guardrail); `warehouseStock` handler still posts opening balances through `stock_adjustments`, never writes `warehouse_stock` directly. Do not regress this.
