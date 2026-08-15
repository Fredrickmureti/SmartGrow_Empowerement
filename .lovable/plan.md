# POS Wave — status (continues the approved plan archived at
# .lovable/plan/pos-wave-transaction-engine-canonical-domain-consumer-audit-2026-08-15.md)

| # | Phase | Verdict | State |
|---|---|---|---|
| 0 | Topology | — | recorded in archived plan |
| 1 | Product consumption / read seam | ✅ fixed | done (this loop) |
| 2 | UoM & packaging contract | ✅ grid parity | done (this loop) |
| 3 | Inventory availability | — | next |
| 4-15 | (unchanged) | — | not started |

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

## Next
Phase 3 — inventory availability: verify POS reads availability only from
`resolve_stock_availability_batch` / canonical stock RPCs (note
`usePOSStockSync` still touches `products.stock_quantity`).
