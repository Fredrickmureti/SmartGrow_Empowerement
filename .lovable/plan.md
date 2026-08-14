# Inventory Product Domain — Foundation Wave (verification verdict + Phase 5B→8)

Authoritative status document. Update it after every implementation step.

## Phase 1 — Independent verification of the previous engineer's claims

Checked directly against the live database and the codebase, not the log.

**Phase 5D — claims confirmed real.** Seven introspection probes returned the
expected values: the five snapshot columns on `landed_cost_allocations`
(`basis_packaging_id`, `basis_qty`, `basis_per_unit`, `basis_uom_id`,
`basis_snapshot_at`) exist; `trg_landed_cost_allocation_immutable` and
`trg_receipt_product_physical_attributes` are both attached and non-internal;
`product_physical_attributes_required` exists; `businesses.require_product_physical_attributes`
exists; `landed_cost_allocate_voucher` still writes `basis_snapshot_at`; and no
allocation row carries a basis quantity without a basis unit (`unitless = 0`).
`InventorySettings.tsx` genuinely reads and writes the policy column.

**Phases 0–5C** were verified in the previous session against the live database
and nothing in this check contradicts that record. No rework of landed phases.

**New findings that change the Phase 5B scope** (evidence, not inference):

1. No supplier-terms resolver exists in the database — zero functions named
   `resolve_supplier_item_terms` / `resolve_supplier_purchasing_terms`. Phase 5B
   is genuinely unstarted.
2. `supplier_item_terms` owns supplier, rank, lead time, min order qty, price
   breaks, currency and effective dates — but has **no order-increment column and
   no supplier UoM**, so it cannot yet be the canonical owner the parent prompt
   requires.
3. `src/hooks/useMOQValidation.ts` performs MOQ and order-increment arithmetic
   **in the browser**, reads only `products.min_order_quantity` /
   `order_quantity_increment`, and ignores supplier terms entirely. It has **zero
   consumers** anywhere in `src/` — it is dead browser-side business logic that
   directly violates the wave's rules of engagement.
4. `ProductForm.tsx` is 1216 lines (Phase 6 still pending, unchanged).

## Phase 5B — Supplier-owned purchasing terms (resume here)

- Extend `supplier_item_terms` with the two facts it is missing to be canonical:
  order increment and supplier purchase UoM (referencing the existing UoM
  tables — no new UoM concept). Supplier SKU/barcode stays where ADR 0114 put
  it: supplier-scoped `product_identifiers`, not a duplicate column here.
- Add one server resolver, `resolve_supplier_purchasing_terms(business, product,
  supplier, on_date)`: effective-dated supplier row first, then the deprecated
  product-level defaults as fallback, returning MOQ, increment, lead time,
  currency, purchase UoM and the source of each value so callers can show where
  a number came from. Validation of a proposed quantity lives in the same
  resolver's SQL sibling, not in React.
- Delete `src/hooks/useMOQValidation.ts` (dead, browser-side) and add a read seam
  hook over the resolver for the purchasing surfaces that will consume it in a
  later wave. No downstream redesign in this wave.
- Mark `products.min_order_quantity` / `order_quantity_increment` as deprecated
  product-level defaults in ADR 0072's successor note; do not drop them yet
  (`ProductForm`, `useProducts`, `useBranchScopedProducts` still read them).
- pgTAP: supplier row wins over product default; expiry of `effective_to` falls
  back; cross-tenant supplier terms are invisible; increment validation refuses
  in SQL.

## Phase 6 — `ProductForm` decomposition

Split the 1216-line file into per-concern sections over the existing
`RecordFormShell`, each fed by the single `saveProductAtomic` command.
Presentation only: no behavioural change, no business rule moved into React.

## Phase 7 — Read-model consolidation

One product read model for list, detail and pickers, with packaging hierarchy,
resolved measures and lifecycle status resolved server-side, so no surface
recomputes product truth locally.

## Phase 8 — Verification sweep (never yet executed end to end)

Run `product_measure_landed_cost_basis_test.sql`,
`product_packaging_hierarchy_test.sql`,
`landed_cost_basis_immutability_test.sql`, the new supplier-terms suite,
`bunx vitest run src/test/architecture`, and a typecheck; then exercise the real
UI: one save creating a nested pack + barcode + weight, and a forced failure
proving nothing was written.

## Technical notes

- Migrations only through the migration tool; every new function is
  `authenticated` + `service_role` with `anon` revoked, matching the identity
  RPC convention.
- Reuse only: `convert_uom`, `resolve_product_identity`,
  `resolve_product_gl_account`, `publish_business_event`,
  `resolve_exchange_rate`, `cost_layers`. No new engines.
- Master data stays separate from transactional state. Product creation never
  creates inventory outside the explicit opening-balance workflow.
- Phases run in order; none is left partially landed.
