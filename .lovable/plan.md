# POS Wave — status (continues the approved plan archived at
# .lovable/plan/pos-wave-transaction-engine-canonical-domain-consumer-audit-2026-08-15.md)

| # | Phase | Verdict | State |
|---|---|---|---|
| 0 | Topology | — | recorded in archived plan |
| 1 | Product consumption / read seam | ✅ fixed | done (this loop) |
| 2 | UoM & packaging contract | ✅ grid parity | done (this loop) |
| 3 | Inventory availability | ✅ fixed | done (this loop) |
| 4 | Pricing & tax authority | — | **ACTIVE NEXT** |
| 5-15 | (unchanged) | — | not started |

## Phase 1 — closed
- Root cause confirmed: `list_products_with_branch_stock` had two overloads
  (4-arg + 5-arg) → PostgREST `PGRST203` on the POS 4-arg call.
- Migration dropped the legacy 4-arg overload; ONE signature remains
  (`org, business, branch, include_variant_parents, warehouse`). The RPC now
  also returns `category_name, tax_rate_name, etims_tax_code, is_weighted,
  plu_code` and filters `is_active AND status='active'`, and resolves
  `tax_rate` from `tax_rates` when a rate id is set. EXECUTE granted to
  `authenticated`/`service_role` only.
- `usePOSProducts` rewritten: RPC-only read, shared `mapCanonicalProductRow`,
  no `from("products")`. `usePOSProductCache`, `ProductPeekDialog` and
  `POSBarcodeSettings` now read the same seam (product-table selects removed
  from POS entirely).
- Guard: `src/test/architecture/pos-product-read-seam.test.ts` (passing) —
  fails the build if any POS file selects from `products` again.

## Phase 2 — closed (grid/scan parity)
- `POSProduct` now carries the canonical contract: `packaging[]`,
  `base_uom_*`, `sales_uom_*`, `category_id`, `is_weighted`, `plu_code`,
  `on_hand/reserved/available`.
- POSTerminal derives `packagedProductIds` from the RPC packaging levels
  (its private `product_packaging` query is gone), stamps `base_uom_id` on
  directly-added and modifier lines, and now sends the real `category_id`
  (previously the category NAME / product type was written to `category_id`).
- Base-unit conversion remains server/dialog-owned; no POS-local UoM math added.

## Known pre-existing failures (NOT introduced by this loop)
`inventory-branch-filter`, `posScopeContaminationGuard`, `posBranchIsolation`,
`inventoryAuditCorrections` and ~100 other architecture suites were already
red before these edits; they belong to later phases / other waves.

## Phase 3 — closed (inventory availability)
Symptom addressed: POS availability decisions and the live stock signal were
both derived from the company-wide `products.stock_quantity` cache, so one
branch reacted to (and could check out against) another branch's stock.

Server (migration applied):
- `pos_register_stock_scope(register)` — ONE place resolving a register's
  (business, branch, warehouse); open shift's warehouse first, else the
  branch default. Both POS availability wrappers now delegate to it.
- `get_available_pos_stock_for_register_batch(product_ids, register,
  exclude_self)` — thin wrapper over `resolve_stock_availability_batch`;
  no availability math re-implemented (ADR 0142). Returns
  `(product_id, available)`, clamped at 0, excludes the register's own holds.
- Both functions: SECURITY DEFINER, `search_path=public`, EXECUTE revoked
  from PUBLIC/anon, granted to `authenticated`/`service_role`.
- `stock_quants` added to the `supabase_realtime` publication with
  `REPLICA IDENTITY FULL` (idempotent guard), so the till can subscribe to
  branch-grained stock instead of the cached aggregate.

Client:
- `usePOSStockSync` realtime now subscribes to `stock_quants` filtered by
  `business_id` (was `products` filtered by `organization_id`). The payload
  is used ONLY for cache invalidation — no wire quantity is a decision input,
  and the misleading cross-branch low/out-of-stock toasts are gone.
- `verifyCartStock` is one batched RPC for the whole cart (was N sequential
  calls, one per line, i.e. an inconsistent snapshot). Duplicate lines of the
  same product are summed before checking, and the call FAILS CLOSED: an
  unreachable authority blocks every line rather than green-lighting a sale.
- `usePOSProducts.hasStock` renamed `hasStockHint` and documented as advisory
  display-only (it reads the cached grid figure).

Guard: `src/test/architecture/pos-availability-authority.test.ts` (4 tests,
passing) — batched register-scoped verification, fail-closed behaviour,
`stock_quants` realtime scope, advisory-only cached hint.

## Currently active
Phase 4 — pricing & tax authority.

## Next agent — start here
1. VERIFY Phases 1-3 before writing anything new:
   - `npx vitest run src/test/architecture/pos-product-read-seam.test.ts
     src/test/architecture/pos-availability-authority.test.ts
     src/hooks/pos/__tests__/inventoryAuditCorrections.test.ts`
     (the only expected failure is the PRE-EXISTING
     `process_pos_transaction` / void-reversal `stock_movements` assertion —
     it is not part of this wave's edits).
   - Confirm exactly one `list_products_with_branch_stock` overload exists and
     that no POS file selects from `products` or from `product_packaging`.
   - Confirm `get_available_pos_stock_for_register[_batch]` both delegate to
     `pos_register_stock_scope` and that neither re-implements availability.
2. THEN resume at Phase 4 (pricing & tax authority): prove POS never computes
   a sellable price or tax client-side — price lists, promotions, happy hour,
   customer-group pricing and eTIMS tax codes must all resolve server-side
   (`pos_resolve_scan` / pricing RPCs), with the cart carrying resolved values
   only. Do not start Phase 5+ or unrelated areas before Phase 4 is closed and
   recorded here.
