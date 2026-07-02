# Inventory module audit verdict

**Audit pass:** zero-trust, system-wide
**Scope:** Inventory module, end-to-end (warehouses, stock movements, adjustments, transfers, reservations, lots, reorder rules, replenishment logs) + integration seams with Sales, Purchases, POS and Finance.
**Status:** ✅ DB-layer safe against cross-branch and cross-business contamination.

---

## 1. Tables & branch identity matrix

| Table                       | organization_id | business_id | branch identity column(s)         |
|-----------------------------|:---------------:|:-----------:|-----------------------------------|
| warehouses                  | ✅              | ✅          | branch_id                         |
| warehouse_stock             | ✅              | ✅          | branch_id                         |
| stock_movements             | ✅              | ✅          | branch_id (trigger-derived)       |
| stock_adjustments           | ✅              | ✅          | branch_id                         |
| stock_adjustment_items      | —               | —           | branch_id (inherits via parent)   |
| stock_transfers             | ✅              | ✅          | from_branch_id + to_branch_id     |
| stock_transfer_items        | —               | —           | inherits via parent               |
| stock_reservations          | ✅              | ✅          | branch_id                         |
| stock_lots                  | ✅              | ✅          | (lot pool — branch-agnostic)      |
| warehouse_stock_lots        | ✅              | ✅          | inherits via warehouse            |
| product_reorder_rules       | ✅              | ✅          | branch_id (nullable = all)        |
| replenishment_logs          | ✅              | ✅          | (business-scoped event log)       |
| products                    | ✅              | ✅          | (catalog — business-scoped)       |
| product_categories          | ✅              | ✅          | (catalog — business-scoped)       |

## 2. RLS hardening (this audit)

All policies on the tables below were rewritten so reads AND writes enforce
`user_can_access_business(uid, business_id)` AND
`can_access_branch(uid, branch_id)` (HQ users implicitly pass), and where
applicable `user_has_module_permission(... 'inventory' ...)`:

- `warehouses` — INSERT/UPDATE/DELETE now branch-gated.
- `warehouse_stock` — INSERT/UPDATE/DELETE now branch-gated.
- `stock_movements` — INSERT/UPDATE/DELETE now branch-gated; SELECT was already gated.
- `stock_adjustments` — full CRUD branch-gated; module key corrected from `products` → `inventory`.
- `stock_transfers` — both `from_branch_id` AND `to_branch_id` must be accessible to write/delete; either side suffices for read.
- `stock_transfer_items` — gated through parent transfer (replaces org-only `org_stock_transfer_items_*`).
- `stock_reservations` — replaced org-only "members" policies with business + branch.
- `stock_lots`, `warehouse_stock_lots` — replaced org-only "members" policies with business arm.
- `product_reorder_rules` — replaced admin-role-on-org with business + branch.
- `replenishment_logs` — replaced org-only with business arm.

Module permission key is `inventory` (consistent with sidebar surface).

## 3. Application-layer status

- `useWarehouses` — branch-scoped reads, branch-stamped writes (warehouses, stock_transfers carry both `from_branch_id` and `to_branch_id` derived from warehouses).
- `useInventory` — reads filter by `branch_id` when active branch is set; writes pass `branch_id: null` to let the `enforce_stock_movement_branch_scope` trigger derive it from the warehouse and reject mismatches. Stock-adjustment headers stamp `branch_id` from the warehouse(s).
- `useWarehouseStockTotals` — branch-aware aggregator.
- `useProductReorderRules` — exposes `branch_id` on the row; rule scoping respected.
- Pages `PhysicalCount`, `ScrapRecording`, `Transfers`, `InventoryDashboard`, `Forecast` — branch-scoped queries via `currentBranch`.

## 4. Architecture guards

- `inventory-branch-filter.test.ts` — every file touching `stock_movements / warehouse_stock / stock_adjustments` references branch context (existing).
- `inventory-branch-id-stamping.test.ts` — **new**. Every `.insert()` into a branch-bearing inventory table includes `branch_id` (or both `from_branch_id` + `to_branch_id` for `stock_transfers`).
- `stock-movement-scope.test.ts`, `stock-adjustment-warehouse-stamp.test.ts`, `no-direct-stock-aggregate-writes.test.ts`, `sales-inventory-integrity.test.ts` — existing safeguards retained.

## 5. Integration seams (verified)

- **Sales → Inventory**: invoice posting / shipment moves create `stock_movements` whose `branch_id` is trigger-derived from the warehouse and validated against the document's `branch_id`.
- **Purchases → Inventory**: bill posting / GRN moves go through the same trigger; branch isolation applies symmetrically.
- **POS → Inventory**: `pos_stock_reservations` carries `branch_id`; reservation reads and writes are branch-gated by RLS.
- **Inventory → Finance**: COGS / valuation JEs derive `branch_id` from the source movement (covered by `je-branch-id-stamping.test.ts`).

## 6. Verdict

The Inventory module is now hardened **at the database layer** against
cross-branch and cross-business contamination across reads, writes, transfers,
reservations, lots and reorder logic. Application-layer scoping was already
in place; RLS now mirrors it. New write-side architecture guard prevents
regressions.
