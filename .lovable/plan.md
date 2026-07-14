## Diagnosis (from first principles)

"Reset Transactional Data" is a Go-Live / sandbox operation: it must return the tenant to a post-implementation baseline where **every transactional artifact is gone**, master data is preserved, and no module can render history that no longer exists. In enterprise ERPs (Odoo, NetSuite, QBO/Xero) this is one canonical pipeline with one authoritative table registry and a coverage check that FAILS if any transactional row survives.

This project already has that shape:

```
OrgDataResetTool → edge fn `clear-org-data`
  → RPC reset_organization_data(org, token)
       audit_unlinks → pos → inventory → fixed_assets → vendor_returns
       → ancillaries → transactions_ledger → banking
       → sales → purchases → finance → sequences
       → coverage_check (recount every "transactional" table)
  → storage GC (receipts, document-pdfs, convention registry)
  → audit_logs insert
```

The pipeline itself is correct. The defect is **incomplete module ownership**: several transactional tables have no owning module, so they are never wiped and never counted by the coverage check. The reset therefore returns `coverage_check: passed` while leaving orphaned history behind, which is what "Inventory > Counts still shows previous adjustments" is a symptom of.

### Root cause — Inventory module scope is a subset of Inventory reality

`reset_module__inventory` (mig `20260422233741`) only touches:
`stock_movements, stock_adjustment_items, stock_adjustments, goods_receipt_items, goods_receipts, backorders, replenishment_logs`.

`governance_modules.inventory.owns_tables` (mig `20260522130812`) further disagrees with the RPC: it lists `warehouse_stock_movements` (a table that doesn't exist) and omits `goods_receipts`, `backorders`, `replenishment_logs`.

Neither the RPC nor the registry owns these transactional inventory tables that do exist in the schema:

- **Physical counting** — `physical_counts`, `physical_count_lines`, `physical_count_events`, `physical_count_freeze_movements`, `physical_count_post_reconciliations` (Inventory > Counts is `.from("physical_counts")` in `PhysicalCountWorkspace.tsx` — this is the visible symptom)
- **Cycle counting** — `cycle_count_schedules`
- **Balances & lots** — `warehouse_stock`, `warehouse_stock_lots`, `stock_lots`, `lot_quarantine`
- **Reservations** — `stock_reservations`, `pos_stock_reservations`
- **Transfers** — `stock_transfers`, `stock_transfer_items` (registered but not deleted by the RPC)
- **Costing subledger** — `cost_layers`, `cost_layer_consumptions`
- **Sales returns (inventory side)** — `sales_returns`, `sales_return_items` live under `sales` module (OK) but their stock effect via `stock_movements` is only cleared indirectly
- **Traceability / regulated** — `product_recalls`, `product_recall_items`, `controlled_substance_register`, `prescriptions`, `prescription_sale_links`, `scan_events`, `scan_events_rate`
- **Ops housekeeping** — `stock_adjustment_backfill_log`, `stock_movements_orphans`, `scrap_attachments`, `reconciliation_sessions`

Because the coverage check UNION only re-counts tables the modules claim to own, the same tables missing from ownership are also missing from the safety net. This is the class of bug — not the specific "Counts page" — that the ADR-0019 governance-plane design is meant to prevent. The registry is the intended single source of truth; it just isn't complete.

Other modules likely have the same gap (payroll audit `2026-05-25-payroll-drift-incident.md` already flagged this class). We'll sweep them all in the same pass.

## Plan

Goal: make Transactional Reset a trusted, single-owner enterprise operation whose ownership registry, teardown routines, coverage check, and preview counts are provably consistent. Once shipped, adding a new transactional table cannot silently escape reset.

### 1. Introduce an "unowned transactional table" invariant (safety net first)

Add a governance test / migration-time check that lists every `public.*` table with an `organization_id` column and asserts each one is either:
- claimed in `governance_modules.owns_tables`, OR
- explicitly registered in a new `governance_transactional_exemptions` table (master data with `organization_id`, e.g. `contacts`, `products`, `warehouses`, `accounts`, `branches`, `businesses`, …), OR
- an audit/log table registered as `preserve_on_reset = true`.

An automated pgTAP test (`supabase/tests/reset_ownership_coverage.sql`) fails CI if any org-scoped table is unclassified. This is the mechanism that keeps the fix from regressing.

### 2. Correct and expand `governance_modules` ownership

Rewrite the `inventory` module registration to match reality and the schema:

```
owns_tables = {
  stock_movements, stock_adjustments, stock_adjustment_items,
  stock_transfers, stock_transfer_items,
  goods_receipts, goods_receipt_items,
  backorders, replenishment_logs,
  physical_counts, physical_count_lines, physical_count_events,
  physical_count_freeze_movements, physical_count_post_reconciliations,
  cycle_count_schedules,
  warehouse_stock, warehouse_stock_lots, stock_lots, lot_quarantine,
  stock_reservations, pos_stock_reservations,
  cost_layers, cost_layer_consumptions,
  scan_events, scan_events_rate,
  product_recalls, product_recall_items,
  controlled_substance_register, prescriptions, prescription_sale_links,
  scrap_attachments, reconciliation_sessions,
  stock_adjustment_backfill_log, stock_movements_orphans
}
derived_projections = { warehouse_stock.quantity, warehouse_stock_lots.quantity }
```

Sweep every other module registration against `governance_list_unowned_tables()`. Assign each currently-unowned org-scoped table to the correct module (Finance, Sales, Purchases, POS, Payroll, Banking, Fixed Assets, HR, Ancillaries), or mark it as master/preserve.

### 3. Bring `reset_module__inventory` in line with ownership

One migration replaces `reset_module__inventory(org_id, business_id)` so it deletes every table the registry now claims, in child→parent order (lines, events, freeze rows, reconciliations → headers → balances → costing → ancillary). It respects the existing `business_id` scope path and the ADR-0019 teardown GUC (`_is_teardown_for_org`) so immutability triggers stand aside.

Do the same corrective sweep for any other module whose `owns_tables` no longer matches its teardown fn.

### 4. Rebuild the coverage check from the registry

The current coverage `UNION ALL` is hand-maintained. Replace it with a single query that reads `governance_modules.owns_tables`, unions row counts across every claimed table for `organization_id = org_id`, and raises if `SUM(count) > 0`. That way the coverage check can never drift from ownership again — they share the same source of truth.

Do the same for `preview_organization_reset` so preview counts are the union of registered ownership, not a hand-picked list.

### 5. Reset derived / cached / projection state

`warehouse_stock`, `warehouse_stock_lots`, `accounts.current_balance`, and any materialized reporting rollups are DERIVED and must land at their zero-state after reset. Two options — we'll implement (a) with (b) as opt-in:

(a) Delete rows for `warehouse_stock`/`warehouse_stock_lots` (they will re-materialize on next movement via existing triggers). Zero `accounts.current_balance` for the org.

(b) Provide a `rebuild_after_reset(org_id)` RPC that reruns `rebuild_warehouse_stock_lots`, refreshes AR/AP open-items projections, and clears in-memory caches on next request. Called at the end of `reset_organization_data`.

Realtime channels are already server-driven, so browsers see the empty state on the next tick.

### 6. UI drill-down safety

Add a `NotFound` boundary and empty-state to `PhysicalCountWorkspace` and any inventory drill-down that lists parent transactions — belt-and-braces for the case where a row is deleted mid-session. This is *not* the fix; the fix is in §2–§5. This just makes drill-downs behave when the source really is gone.

### 7. Documentation & ADR

- Update `docs/ORG_DATA_RESET.md` with the corrected inventory scope, the "registry is the single source of truth" invariant, and the derived-state rebuild step.
- New ADR "Reset ownership is registry-driven and enforced at CI" documenting the invariant test and the process for adding a new transactional table (register → owner module → automatic coverage).

### 8. Regression tests

- `supabase/tests/reset_organization_data.sql` (pgTAP): seed physical_counts, cycle_count_schedules, stock_reservations, cost_layers, warehouse_stock_lots, controlled_substance_register, scan_events; run reset; assert 0 rows each and `coverage_check = passed`.
- `supabase/tests/reset_ownership_coverage.sql`: assert `governance_list_unowned_tables()` is empty.
- Vitest architecture test (`src/test/architecture/reset-registry-consistency.test.ts`): parse the migration files, assert every `reset_module__*` DELETE target is a member of that module's `owns_tables`.

### 9. Rollout order

1. Registry + exemption table + failing pgTAP invariant.
2. Corrected `reset_module__inventory` + other module fills.
3. Registry-driven coverage/preview.
4. Derived-state rebuild + `warehouse_stock` zeroing.
5. UI drill-down empty states.
6. Docs + ADR.

Each step is an independent migration/edit and can be verified via the pgTAP suite before the next lands.

### Out of scope (intentional)

- Changing what "reset" preserves (COA, contacts, products, tax codes, subscription, users/roles, branding) — that is correct per Xero/QBO/NetSuite convention.
- Hiding orphaned records in the UI. Symptoms are addressed at the source, not the view.
- Deleting inventory adjustments outside the reset pipeline. Post-approval adjustments remain immutable and reversible per ADR-0016.
