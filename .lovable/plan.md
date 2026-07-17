# Inventory Foundation — Session 8 plan

Continuation of `.lovable/plan.md`. Session 7 handoff lists five open priorities (A–E) plus ops-blocked items. This plan verifies session-7 claims first, then executes what's actionable.

## Phase 1 — Verify session-7 claims before writing code

Confirm each "DONE" item is real; treat any gap as pending work.

1. **Split product importers + outbox emission** — confirm all 8 files present under `src/lib/importConfigs/product/`, all six handlers export `create<Name>BatchMigrationHandler(ctx)`, all six call `emitProductImportCompleted`, compat shim + barrel re-export all six, guard test on disk. (Files already listed — spot-check content only.)
2. **Master handler signature** — `MigrationStepProducts.tsx` passes `ImportContext` (not `orgId` string).
3. **`emit_business_event` RPC** — exists in DB, SECURITY DEFINER, whitelists `product.import.*` + `stock.*`, enforces `user_business_access`, dedupes on `idempotency_key`. Verify via `supabase--read_query` on `pg_proc`.
4. **Stock event fabric trigger** — `tg_stock_movement_emit_event` exists on `stock_movements`, emits correct event types per `movement_type`, skips `is_sample_data`, swallows outbox failures. Verify via `pg_trigger` + function source.
5. **3-way match + landed cost schema** — `bills.goods_receipt_id` column, tables `bill_grn_matches`, `landed_cost_bills`, `landed_cost_allocations` exist with RLS + GRANTs.
6. **Reversal + landed-cost posting RPCs** — `reverse_stock_movement`, `post_landed_cost_bill`, `reverse_landed_cost_bill` present; `stock_movements.reverses_movement_id` column + `landed_cost` in `movement_type` CHECK.
7. **`tsgo --noEmit`** clean baseline before touching code.

Anything not verifiable moves into Phase 3 as prerequisite work; no plan expansion unless a real defect is found.

## Phase 2 — Plan additions

None expected. The handoff's Priorities A–E already cover the remaining architectural gaps. Only add phases if verification surfaces a defect (e.g. trigger doesn't skip sample data, RPC signature wrong, missing GRANT).

## Phase 3 — Execute the open priorities in order

### Priority A — Wire the Stock Event Fabric to one real consumer

Prove ADR 0076 by moving one direct-trigger consumer onto the outbox.

- Enumerate `AFTER INSERT` triggers on `stock_movements` in the DB. Pick the highest-value one: Finance COGS journal poster preferred; else replenishment recompute.
- Add a handler under `src/services/events/handlers/` subscribing to `stock.movement.dispatched` (COGS) or `.received` (replenishment) through `BusinessSaga`.
- Register in `src/services/events/index.ts`.
- Remove the direct DB trigger in the same migration (idempotent — handler must be running before drop is safe; if we can't guarantee that, keep the trigger and mark it dual-write with a follow-up cut-over ticket).
- Smoke: post one stock movement, confirm the journal entry / replenishment side-effect fires from the saga path only.

### Priority B — Server-side `stock.*` emission for non-movement domain events

- Audit callers of `recordStockMovement` in `src/lib/inventory/stockLedger.ts` and RPC callers.
- Add explicit `emit_business_event` calls for domain events that don't map 1:1 to a movement: `stock.count.completed`, `stock.transfer.approved`, `stock.transfer.received`, `stock.adjustment.posted` where relevant.
- Emission must be transactional in RPCs (server) and best-effort in client callers, matching the import-handler pattern.

### Priority C — Landed-cost allocation calculator

- Add RPC `allocate_landed_cost_bill(p_bill_id)` (SECURITY DEFINER, org+role gated) that:
  - reads `landed_cost_bills.allocation_basis` (`quantity | value | weight | manual`),
  - fans `total_amount` across linked GRN lines using that basis,
  - inserts `landed_cost_allocations` rows,
  - transitions bill status `draft` → `allocated`.
  - `manual` basis: leave allocations to be authored via UI; RPC just validates + flips status when sums match.
- Minimal UI under `src/features/inventory/landed-cost/`: list bills, allocate, post, reverse. Uses existing design-system primitives; no new tokens.

### Priority D — Auto-populate `bill_grn_matches` + UI

- Add RPC `match_bill_to_grn(p_bill_id)`:
  - For each `bill_items` row with `purchase_order_item_id`, join `goods_receipt_items` on the same PO line, insert `bill_grn_matches` with `matched_quantity = LEAST(billed_qty, received_qty)` and `unit_cost_variance = bill_unit_cost - po_unit_cost`.
  - Idempotent via existing UNIQUE `(bill_item_id, goods_receipt_item_id)`.
- Surface unmatched lines in the existing Bills detail view (variance chip + "Match to GRN" action). Read-only if user lacks accountant/admin role.

### Priority E — End-to-end verification of master-handler outbox emission

- Runtime smoke: trigger a real product-master import through the Migration wizard against a scratch business, assert one `business_event_outbox` row with `event_type = product.import.completed` (or `.completed_with_errors`) and the expected idempotency key shape.
- If emission is silently swallowed, fix the RPC allow-list or the helper — do not paper over with a log.

## Ops-blocked (unchanged, do not touch from code)

- `cron_caller_jwt` rotation — Steps 1/2/3 stay parked.
- Step 5 recall-notification worker — awaits product-owner copy.
- G1/G2/G3 audit gaps — await stakeholder input.

## Out of scope

- Any UI polish beyond the minimal landed-cost + bill-match surfaces.
- Touching `cost_layers` code (ADR 0078 decision stands; no consumers).
- Fixing the 1823 pre-existing linter findings — belong to other modules.
- Deleting legacy `warehouse_stock` / `products.stock_quantity` — gated on 14 zero-drift nights.

## Technical notes

- New RPCs land in one migration per priority (C, D). Each RPC is SECURITY DEFINER with explicit `user_business_access` + role check; no service_role fallback.
- New tables (none expected) would require GRANTs in the same migration per project rules.
- Client code uses existing `supabase` client; no new hand-rolled clients.
- Event handler files are pure functions registered at module load; no top-level Supabase realtime subscriptions outside `useEffect`.

## Deliverable per priority

For A–E, produce:
- Migration file(s) if DB work,
- Handler / RPC / UI code,
- One targeted architecture or integration test under `src/test/architecture/` or `src/test/integration/`,
- A one-paragraph execution-log entry appended to `.lovable/plan.md` (verified evidence, not aspirational).
