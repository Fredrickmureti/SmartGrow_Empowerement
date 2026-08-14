# Inventory Product Domain — Foundation Wave (live status)

Authoritative status document. Update it after every implementation step.

**Active phase:** Phase 5D — COMPLETE (landed-cost basis snapshot + posted-history
immutability, physical-attribute purchasing policy, guard suite).
**Next phase:** Phase 5B (product lifecycle events already landed in 5C's
migration; what remains is the supplier-owned purchasing terms resolver + ADR
note), then Phase 6 (`ProductForm` decomposition), Phase 7 (read model),
Phase 8 (verification sweep).

## Completed and verified

### Phases 0–4 — foundation (verified against the live database)
- `products` carries no `etims_*` columns; fiscal metadata lives per jurisdiction
  in `product_tax_localization`.
- Lifecycle columns `status`, `archived_at`, `archived_by`, `lifecycle_reason`.
- `save_product_atomic`, `resolve_product_measure`,
  `set_product_lifecycle_status`, `upsert_product_tax_localization`,
  `resolve_product_tax_localization`, `resolve_fiscal_jurisdiction` all exist.
- `product_physical_attributes`, `product_tax_localization`,
  `supplier_item_terms` present; `product_packaging` carries the hierarchy
  (`parent_packaging_id`, `qty_in_parent`, `is_shipping_unit`).

### Phase 5C — lifecycle & localization client (COMPLETE)
- `src/features/products/localization/productTaxLocalization.ts` — read seam +
  `useProductTaxLocalization` hook over `resolve_product_tax_localization`.
- `ProductForm` keeps fiscal codes in a dedicated `localization` state and
  submits them as the `localization` payload of `saveProductAtomic`; no
  `(editing as any).etims_*` reads remain.
- `OverviewTab` Compliance section reads the localization seam.
- `save_product_atomic` now **rejects** legacy `etims_*` master keys with
  `PRODUCT_PAYLOAD_INVALID`, and emits `product.updated`;
  `set_product_lifecycle_status` emits `product.status_changed`.
- `ProductDetailPanel` shows the real lifecycle status with a guarded
  `ProductLifecycleAction`; product queries read `status`, not derived
  `is_active`; `src/test/architecture/products-status-is-truth.test.ts` keeps it
  that way.

### Phase 5D — historical immutability & purchasing policy (COMPLETE)
- `landed_cost_allocations` gained the measurement snapshot:
  `basis_packaging_id`, `basis_qty`, `basis_per_unit`, `basis_uom_id`,
  `basis_snapshot_at`. `landed_cost_allocate_voucher` writes it on every line,
  in the business reference unit of the dimension, at the packaging level the
  receipt line was actually received in. Editing a product weight later can no
  longer change what an already-allocated voucher meant.
- `trg_landed_cost_allocation_immutable` on `landed_cost_allocations`: once the
  parent voucher is `posted`, lines cannot be deleted and their basis, ratio or
  amount cannot be rewritten (`LANDED_COST_ALLOCATION_IMMUTABLE`); the system's
  own capitalised/expensed results remain writable. Reversal stays the only
  remedy. Draft/allocated vouchers are still freely re-allocatable.
- Physical attributes became configuration, not an allocation-time surprise:
  `businesses.require_product_physical_attributes` (default `false`),
  resolver `product_physical_attributes_required(business_id)`, and
  `trg_receipt_product_physical_attributes` on `goods_receipt_items` raising
  `PRODUCT_PHYSICAL_ATTRIBUTES_REQUIRED` at receipt time when the policy is on.
  Surfaced in `src/components/settings/InventorySettings.tsx` as a company-scoped
  toggle beside the cost model.
- `supabase/tests/landed_cost_basis_immutability_test.sql` pins all of the above
  (snapshot columns, allocator snapshotting, posted delete/update refusal,
  draft mutability, policy plumbing, and a live-data check that no physical
  snapshot is unit-less).
- Verified this session: all seven introspection probes return the expected
  values against the live database, `unitless = 0`, and `bunx tsgo --noEmit`
  passes clean.

## Still pending

### Phase 5B — supplier-owned purchasing terms
Confirm `supplier_item_terms` is the canonical owner of MOQ, order increment,
lead time, supplier SKU/UoM/currency and effective dates; add a resolver with a
product-level fallback and mark `products.min_order_quantity` /
`order_quantity_increment` as deprecated defaults in the ADR. No new engine.
(Product lifecycle event emission — originally item 5 of this phase — already
landed with the Phase 5C migration.)

### Phase 6 — `ProductForm` decomposition
Split the ~1180-line file into per-concern sections over the existing
`RecordFormShell`, each fed by the single `saveProductAtomic` command.
Presentation only; no behavioural change, no business rules moved into React.

### Phase 7 — Read-model consolidation
One product read model for list, detail and pickers, with the packaging
hierarchy, resolved measures and lifecycle status resolved server-side.

### Phase 8 — Verification sweep (never yet executed end to end)
Run `product_measure_landed_cost_basis_test.sql`,
`product_packaging_hierarchy_test.sql`,
`landed_cost_basis_immutability_test.sql`,
`bunx vitest run src/test/architecture`, plus a typecheck; then exercise the real
UI: one save creating a nested pack + barcode + weight, and a forced failure
proving nothing was written.

## Instructions for the next agent

1. **Verify Phase 5D before writing anything new.** Re-run the introspection in
   `supabase/tests/landed_cost_basis_immutability_test.sql` against the live
   database. Confirm: the five snapshot columns exist; both triggers are
   attached and not internal; `product_physical_attributes_required` exists and
   defaults to `false`; `landed_cost_allocate_voucher` still contains
   `basis_snapshot_at`; and no `weight`/`volume` allocation carries a snapshot
   without `basis_uom_id`. Also confirm the settings toggle in
   `InventorySettings.tsx` reads and writes
   `businesses.require_product_physical_attributes`.
2. If any of that fails, fix it before progressing — do not stack a new phase on
   an unverified one.
3. **Then resume at Phase 5B** (supplier-owned purchasing terms), not at an
   unrelated area. Phases run in order; none is left partially landed.

## Rules of engagement (unchanged)

No new engines — reuse `convert_uom`, `resolve_product_identity`,
`resolve_product_gl_account`, `publish_business_event`, `resolve_exchange_rate`,
`cost_layers`. No business logic in the browser. Master data stays separate from
transactional state. Product creation never creates inventory outside the
explicit opening-balance workflow.
