# Inventory Product Domain — Foundation Wave (live status)

Authoritative status document. Update it after every implementation step.

**Active phase:** Phase 5C — COMPLETE (localization client, lifecycle badge +
action, `status` repointing, architecture guard test).
**Next phase:** Phase 5B (supplier terms resolver + ADR note), Phase 5D,
Phase 6 (`ProductForm` decomposition), Phase 7 (read model), Phase 8 (tests).


## Independent verification (this session)

Re-checked the previous engineer's claims directly against the live database and
the codebase rather than trusting the log.

Confirmed real:
- `products` has **zero** `etims_*` columns; all 4 products have exactly one
  `product_tax_localization` row. The localization extraction genuinely landed.
- Lifecycle columns `status`, `archived_at`, `archived_by`, `lifecycle_reason`
  all exist on `products`.
- All six claimed functions exist: `save_product_atomic`,
  `resolve_product_measure`, `set_product_lifecycle_status`,
  `upsert_product_tax_localization`, `resolve_product_tax_localization`,
  `resolve_fiscal_jurisdiction`.
- Tables `product_physical_attributes`, `product_tax_localization` and the
  pre-existing `supplier_item_terms` are present.
- `product_packaging` carries `parent_packaging_id`, `qty_in_parent`,
  `is_shipping_unit` — Phase 3 landed.

Confirmed still open (matches the previous engineer's own "remaining" list, so the
log is honest, not inflated):
- `ProductForm.tsx` still holds `etims_classification_code`, `etims_unit_code`,
  `etims_packaging_unit`, `etims_country_origin` in `formData` and hydrates them
  from `(editing as any).etims_*` — columns that no longer exist. **Today those
  four fields silently hydrate empty on every edit and round-trip through the
  backend compat layer.** This is a live data-integrity defect, not cosmetic.
- `ProductDetailPanel.tsx` still renders the badge from `product.is_active ===
  false`. `is_active` is now a derived column; the real lifecycle
  (draft/active/deprecated/archived) is invisible everywhere in the UI.
- No product lifecycle action exists in the UI at all — `set_product_lifecycle_status`
  has no caller.
- Only `product.created` is emitted through `publish_business_event`;
  `product.updated` and `product.archived` are not.
- `ProductForm.tsx` is still 1182 lines.
- The two SQL suites written in earlier phases have still never been executed.

Verdict: Phases 0–4 are real and Phase 5's backend is real. The wave is genuinely
at the point the log claims. No rework of landed phases is required.

## Plan

### Phase 5C — Finish the lifecycle & localization client (first, in order)
1. Move the four eTIMS fields out of `formData` into a dedicated `localization`
   state in `ProductForm`, hydrate on edit via `resolve_product_tax_localization`,
   and submit them as the `localization` payload of `saveProductAtomic`. Remove
   the `(editing as any).etims_*` reads.
2. Once no client sends legacy keys, drop the `etims_*` compat branch from
   `save_product_atomic` so there is one shape, not two.
3. Replace the `is_active === false` badge in `ProductDetailPanel` with a status
   badge and a lifecycle action driven by `allowedProductTransitions` /
   `setProductLifecycleStatus`, surfacing `PRODUCT_ARCHIVE_HAS_STOCK` through the
   existing operator-copy seam (no SQLSTATE in a toast).
4. Repoint product pickers and list queries from `is_active` to
   `status = 'active'`, and add an architecture test forbidding new
   `is_active` filters on `products` so the derived column cannot drift back into
   being treated as truth.

### Phase 5B — Events and supplier-owned purchasing terms
5. Emit `product.updated` and `product.archived` through `publish_business_event`
   from the canonical write seams (`save_product_atomic`,
   `set_product_lifecycle_status`) — not from the browser.
6. Supplier-product relationship (in the parent prompt, absent from every prior
   phase): confirm `supplier_item_terms` is the canonical owner of MOQ, order
   increment, lead time, supplier SKU/UoM/currency and effective dates; add a
   resolver with a product-level fallback and mark `products.min_order_quantity`
   / `order_quantity_increment` as deprecated defaults in the ADR. No new engine.

### Phase 5D — Historical immutability (appended; a real gap)
7. Editing a product weight today retroactively changes how an already-posted
   landed-cost voucher would allocate. Snapshot the allocation basis on the
   voucher line at apply time so posted history cannot change meaning, and pin it
   with a pgTAP test.
8. Make "may a product without physical attributes be purchased/received" a
   configuration value in the existing settings hierarchy rather than a failure
   that only appears at allocation time.

### Phase 6 — `ProductForm` decomposition
Split the 1182-line file into per-concern sections over the existing
`RecordFormShell`, each fed by the single `saveProductAtomic` command.
Presentation only; no behavioural change and no business rules moved into React.

### Phase 7 — Read-model consolidation
One product read model for list, detail and pickers, with the packaging hierarchy,
resolved measures and lifecycle status resolved server-side.

### Phase 8 — Verification sweep (never yet run)
Execute `product_measure_landed_cost_basis_test.sql`,
`product_packaging_hierarchy_test.sql`, `bunx vitest run src/test/architecture`
and a typecheck; then exercise the real UI: one save creating a nested pack +
barcode + weight, and a forced failure proving nothing was written.

## Rules of engagement (unchanged)
No new engines — reuse `convert_uom`, `resolve_product_identity`,
`resolve_product_gl_account`, `publish_business_event`, `resolve_exchange_rate`,
`cost_layers`. No business logic in the browser. Master data stays separate from
transactional state. Product creation never creates inventory outside the explicit
opening-balance workflow. Phases run in order; none is left partially landed.
