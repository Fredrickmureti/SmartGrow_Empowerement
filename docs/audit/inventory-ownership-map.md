# Inventory Domain — Ownership Map & Write-Path Inventory

Phase 3, Step 1 discovery deliverable. **No code changes in this
document — findings only. Batches I1–I7 execute against this map.**

## 1. Tables Inventory owns

Canonical set — Inventory is the sole authoring authority for state
and value on these tables. All cross-app writes must transit
`business_event_outbox` and be consumed by a sanctioned Inventory RPC.

| Table | Role | Cross-app read? | Cross-app write? |
|---|---|---|---|
| `stock_movements` | Immutable ledger of every base-unit motion | yes | **never** (event only) |
| `stock_quants` | On-hand per (product, location, lot) — projection of `stock_movements` | yes | **never** (maintained by trigger `_maintain_stock_quants`) |
| `warehouse_stock` | Warehouse-level rollup — projection | yes | **never** |
| `warehouse_stock_lots` | Warehouse × lot rollup — projection | yes | **never** (`_maintain_warehouse_stock_lots`) |
| `cost_layers`, `cost_layer_consumptions` | AVCO layers + consumption (ADR 0078) | valuation reads | **never** (`_maintain_cost_layers`) |
| `stock_lots`, `stock_serials` | Lot / serial master with expiry, quarantine | yes | write only via receipt/adjustment RPCs |
| `lot_quarantine` | Quarantine state for a lot | yes | via `write_off_lot_atomic` / QC event only |
| `stock_reservations` | Soft holds against on-hand | yes | via `create_stock_reservation` / `release_stock_reservation` |
| `stock_transfers`, `stock_transfer_items` | Inter-location transfer aggregate | yes | Inventory RPCs only |
| `stock_adjustments`, `stock_adjustment_items` | Manual adjustment aggregate | yes | Inventory RPCs only |
| `physical_counts`, `physical_count_lines` | Variance approval + posting authority (ADR 0080) | yes | Inventory RPCs only |
| `stock_locations` | Physical hierarchy — **schema owned by Inventory, authored via Warehouse UI** (ADR 0079) | yes | Warehouse UI only |

## 2. Canonical RPC surface — actual DB state

The `.lovable/plan.md` idealised names differ from what ships. The
**real** canonical set already in Supabase, all `SECURITY DEFINER` +
`search_path=public`:

| Domain | Canonical RPC(s) | Notes |
|---|---|---|
| Stock adjustment | `apply_or_request_stock_adjustment`, `approve_stock_adjustment_atomic`, `post_stock_adjustment_gl` | Approve/post split; self-approval blocked by `guard_stock_adjustment_self_approval` |
| Stock transfer | `approve_stock_transfer_atomic`, `complete_stock_transfer_atomic`, `cancel_stock_transfer_atomic` | Self-approval blocked by `guard_stock_transfer_self_approval` |
| Physical count | `physical_count_create/submit/freeze/approve/post/cancel/record_line/request_recount/supersede/preflight/preview_je` | Complete lifecycle; freeze enforced by `enforce_physical_count_freeze` |
| Reservations | `create_stock_reservation`, `release_stock_reservation`, `consume_so_reservation`, `restore_so_reservation`, `release_sales_order_reservations_atomic`, `release_pos_stock_reservation`, `expire_stock_reservations` | POS + Sales consumers all funnel through these |
| Invoice / return integration | `confirm_invoice_and_release_stock_atomic`, `restore_invoice_stock_atomic` | Sales-side; writes go via RPC |
| Opening stock / product create | `create_product_with_opening_stock_atomic` | The only sanctioned path to seed a new product's opening stock |
| Drift / reconciliation | `check_stock_quant_drift`, `record_stock_quant_drift_run`, `reconcile_stock_quantities`, `rebuild_warehouse_stock_lots` | Ops tools |
| Alerts | `check_low_stock_products`, `check_product_stock_and_notify`, `check_warehouse_stock_alerts`, `notify_low_stock_realtime`, `get_low_stock_by_branch` | Read-side |
| Movement provenance | `enforce_stock_movement_immutability`, `enforce_stock_movement_provenance`, `enforce_stock_movement_branch_scope` | Triggers — every movement must carry provenance |

**Gaps vs. the roadmap's idealised names:**

| Roadmap name | Reality |
|---|---|
| `post_stock_adjustment_atomic` | Split as `apply_or_request_stock_adjustment` + `approve_stock_adjustment_atomic`. **Keep the split; retire the idealised name** — it doesn't exist. |
| `post_physical_count_atomic` | `physical_count_post`. **Rename the roadmap, not the RPC.** |
| `execute_stock_transfer_atomic` | `complete_stock_transfer_atomic` (plus `approve_*`, `cancel_*`). Rename roadmap. |
| `reserve_stock_atomic` / `release_reservation_atomic` | `create_stock_reservation` / `release_stock_reservation`. Rename roadmap. |
| `revalue_layer_atomic` | **Missing.** Only `revalue_fx_balances` exists (FX, not inventory revaluation). **New RPC required in I1** for cost-layer revaluation. |
| `write_off_lot_atomic` | **Missing.** Currently no sanctioned RPC exists for lot write-off — write-offs today would flow through `apply_or_request_stock_adjustment`. **Decision needed in ADR 0081:** either fold lot write-off into stock-adjustment (no new RPC) or create a dedicated one for lot lifecycle + quarantine emission. |

## 3. Direct-write violations (must be fixed by I1 / I5 / I6)

`rg` across `src/` for `.from('<inventory_table>').insert|update|delete|upsert` outside
`src/apps/inventory/**`, `src/integrations/**`, `src/test/**`:

| File | Line | Table | Verdict |
|---|---|---|---|
| `src/pages/warehouse/WarehouseLayoutPage.tsx` | 185 | `stock_locations` | **Sanctioned by ADR 0079** — Warehouse UI is the authoring surface for `stock_locations`. Wrap in an RPC in I1 to unify grant surface and enable audit; do not remove the capability. |
| `src/hooks/useWarehouses.ts` | 323 | `stock_transfer_items` | **Violation.** Move through `approve_stock_transfer_atomic` / `complete_stock_transfer_atomic`. Fix in I1. |
| `src/lib/importConfigs/product/productWarehouseStockImportConfig.ts` | 123 | `stock_adjustment_items` | **Violation.** Route through `apply_or_request_stock_adjustment`. Fix in I1. |
| `src/lib/importConfigs/product/productBatchImportConfig.ts` | 56 | `stock_lots` | **Violation.** Needs a `create_stock_lot_atomic` RPC (batch-import sanctioned caller). Add in I1. |
| `src/components/migration/steps/MigrationStepInventory.tsx` | 187 | `stock_movements` | **Migration-only bypass.** Requires an explicit allow-list entry in the I6 arch test and a `SECURITY DEFINER` `import_stock_movement_atomic` gated by `migration.import` duty. Fix in I1. |

Zero violations against `cost_layers`, `cost_layer_consumptions`,
`warehouse_stock`, `warehouse_stock_lots`, `physical_counts`,
`physical_count_lines`, `lot_quarantine`, `stock_quants`,
`stock_reservations`. Those tables are already RPC-only across the app.

## 4. Governance duties — current vs. required

Present today (`governance_duties`):

- `inventory.adjust`
- `inventory.approve_adjustment`

Required by Phase 3 (I2):

| Duty | Purpose | SoD conflict with |
|---|---|---|
| `inventory.adjust.request` | Create a draft adjustment | — |
| `inventory.adjust.approve` | Approve adjustment (rename of `inventory.approve_adjustment`) | `inventory.adjust.post` |
| `inventory.adjust.post` | Post adjustment to ledger | `inventory.adjust.approve` |
| `inventory.transfer.approve` | Approve transfer | `inventory.transfer.execute` |
| `inventory.transfer.execute` | Complete transfer at destination | `inventory.transfer.approve` |
| `inventory.count.approve` | Approve variance | `inventory.count.post` |
| `inventory.count.post` | Post count adjustments | `inventory.count.approve` |
| `inventory.revalue.post` | Post cost-layer revaluation | requires senior approver |
| `inventory.lot.writeoff` | Write off a lot | requires QC + finance sign-off |

The existing `inventory.adjust` / `inventory.approve_adjustment` are
kept as aliases through the migration (I2) so no permission grants are
lost, then dropped at the end of I2 once all callers repoint.

## 5. Inbound cross-domain events

Verify (I4) that each event is emitted by the producing app and has an
idempotent consumer inside Inventory:

| Event | Producer | Inventory consumer | Idempotency key |
|---|---|---|---|
| `procurement.grn.received` | Procurement `create_goods_receipt` | needs consumer that emits `stock_movements` inbound | `stock.movement:<grn_line_id>` |
| `warehouse.count.session.completed` | Warehouse `wms_count_sessions.post` | materialises `physical_counts` row for review (per ADR 0080) | `physical_count:<session_id>` |
| `manufacturing.production.completed` | Manufacturing (future) | inbound stock movement + cost layer | `stock.movement:<mo_id>` |
| `sales.shipment.picked` | Sales delivery notes | outbound stock movement, layer consumption | `stock.movement:<delivery_note_line_id>` |
| `sales.return.received` | Sales returns | inbound movement | `stock.movement:<return_line_id>` |

Handlers found today: some flow directly (no outbox) — e.g. delivery
note completion writes movements inline. **I4 formalises the outbox
contract and adds idempotent consumers where missing.**

## 6. UI duplication scan

`src/pages/inventory/` no longer contains any warehouse-shaped page
(ADR 0080). Remaining risk areas to audit in I5:

- Any transfer / adjustment surfaces still living outside
  `src/apps/inventory/**` — flag and either move under the inventory
  app or delete.
- Legacy `Counts` vs. `PhysicalCountWorkspace` naming: confirm one
  workspace, not two, for the review/post surface.

## 7. Integrity-trigger gap analysis (feeds I3)

Already present:
- `enforce_stock_movement_branch_scope`
- `enforce_stock_movement_immutability`
- `enforce_stock_movement_provenance`
- `enforce_stock_transfer_branches_match`
- `enforce_warehouse_stock_branch_consistency`
- `guard_products_stock_quantity` (+ `_insert` variant)

Missing / to add in I3:
- `enforce_stock_movement_location_business` — reject when
  `source_location_id` / `destination_location_id` do not share
  `business_id` with the movement.
- `enforce_stock_quant_nonnegative` — trigger on `stock_quants` that
  raises when `on_hand < 0` unless the current statement is inside a
  sanctioned reversal RPC (detect via `pg_trigger_depth() > 0` OR a
  session GUC set by the RPC — pattern already used elsewhere).
- `enforce_cost_layer_business_alignment` — layers must match their
  originating movement's `business_id`.

## Ready to open

With Steps 0 + 1 complete, Phase 3 is unblocked. **Next turn: draft
ADR 0081 (Step 2) then execute I1.**
