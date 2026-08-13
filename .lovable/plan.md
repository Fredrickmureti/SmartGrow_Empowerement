# Inventory Product Domain — Foundation Wave (live status)

Authoritative status document. Update it after every implementation step.

**Active phase:** Phase 4 (atomic product write) — COMPLETE.
**Next phase:** Phase 5 — product lifecycle & localization extraction.

## Completed and verified

### Phase 0 — Architecture report
`docs/adr/0140-product-domain-foundation.md` records the target shape of the
product domain.

### Phase 1 — Physical attributes foundation
`product_physical_attributes` (base level + per-packaging level),
`resolve_product_measure` as the single read seam, `uom_categories.dimension`
populated, volume/length units seeded.

### Phase 2 — Landed cost weight/volume allocation
`landed_cost_allocate_voucher` supports the `weight` and `volume` bases through
the measure seam.

### Phase 2R — Hardening (defects found during independent verification)
- `resolve_product_measure` is now **fail-closed**: no configured reference unit
  raises instead of returning raw, unconvertible numbers. Reference-unit choice
  is deterministic (no `LIMIT 1` lottery).
- Landed cost measures a receipt line at **its own packaging level**
  (`packaging_id` × `display_quantity`) — a case weighs a case.
- `_landed_cost_post_apply` resolves Inventory/COGS accounts per product via
  `resolve_product_gl_account` and groups journal lines by resolved account,
  replacing the generic posting accounts.
- Guard: `supabase/tests/product_measure_landed_cost_basis_test.sql`.

### Phase 3 — Nested packaging structure
- `product_packaging` gains `parent_packaging_id`, `qty_in_parent`,
  `is_shipping_unit`. `qty_in_base_uom` remains canonical for all arithmetic;
  `qty_in_parent` is derived when omitted.
- `trg_enforce_packaging_hierarchy` refuses cycles, cross-product/business
  parents, depth beyond 8 levels, and any child whose base quantity contradicts
  parent × units-per-parent. `trg_repropagate_packaging_children` refuses a
  parent quantity change that would contradict a nested level.
- One shipping unit per product (partial unique index).
- Guard: `supabase/tests/product_packaging_hierarchy_test.sql`.

### Phase 4 — Atomic product write
- `save_product_atomic(p_product, p_product_id, p_packaging, p_physical,
  p_identifiers)` saves master + packaging + measurements + identifiers in ONE
  transaction. Identifier rows are routed through `upsert_product_identifier` /
  `retire_product_identifier`, so identity invariants stay in one place.
  New packaging levels are referenceable inside the same payload via
  `client_key` / `parent_client_key` / `packaging_client_key`.
  `authenticated` + `service_role` only; `anon`/`PUBLIC` revoked.
- Client seam `src/features/products/save/saveProductAtomic.ts` owns the
  operator copy (`describeProductSaveFailure`) — no SQLSTATE reaches a toast.
- `ProductForm` submits one call for both create and edit. The three
  best-effort `commit()` calls are gone, so "product created — packaging save
  failed" half-records are structurally impossible.
- The editors expose `collect()` payloads (`ProductPackagingEditor`,
  `ProductPhysicalAttributesEditor`, `ProductIdentifiersEditor`); `commit()`
  remains only for their standalone in-place save buttons.
- Opening stock deliberately keeps `create_product_with_opening_stock_atomic`
  (it posts to the ledger and may require approval); children are saved
  atomically immediately after in that one path.
- Guards: `src/test/architecture/product-save-single-transaction.test.ts`,
  section 7 of `product_packaging_hierarchy_test.sql`.

## Pending

### Phase 5 — Product lifecycle & localization extraction (NEXT)
- `products` has no `status` / `archived_at`; `is_active` is a boolean stand-in
  that cannot express draft vs active vs discontinued vs archived.
- Add a lifecycle enum + transition guard, and block sales/purchase selection
  of non-sellable states at the database, not just in pickers.
- Move the `etims_*` columns off `products` into a localization extension table
  so the core master stops carrying one country's tax vocabulary.

### Phase 6 — `ProductForm` decomposition
1193 lines in one file. Split into per-concern sections driven by the existing
`RecordFormShell` sections; no behavioural change.

### Phase 7 — Read-model consolidation
One product read model for list/detail/pickers, with the packaging hierarchy
and measurements resolved server-side.

## Verification not yet run
The two new SQL suites (`product_measure_landed_cost_basis_test.sql`,
`product_packaging_hierarchy_test.sql`) have not been executed against a live
database — they are written to run inside a rolled-back transaction and need a
psql/pgTAP run.

## Instructions for the next agent
1. **Verify before building.** Run the two SQL suites above and
   `bunx vitest run src/test/architecture` plus `bunx tsgo --noEmit -p
   tsconfig.app.json`. Then exercise the real UI: create a product with a
   nested pack, a barcode and a weight in one save, and confirm one
   transaction wrote everything; force a failure (e.g. contradictory pack
   quantity) and confirm NOTHING was written and the operator sees the copy
   from `describeProductSaveFailure`.
2. Confirm `save_product_atomic` never writes `product_identifiers` directly
   and stays `authenticated`-only.
3. Only after that, start **Phase 5** — do not pick unrelated work, and do not
   leave the lifecycle model half-applied (schema, guards, pickers and posting
   paths land together).
