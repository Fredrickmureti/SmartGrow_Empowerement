# Inventory Product Domain — Foundation Wave (verification verdict + Phase 6 close-out → Phase 8)

Authoritative status document. Update it after every implementation step.

## Phase 1 — Verification of the previous engineer's claims (this session)

Checked directly in the codebase, not against the log.

Confirmed real:
- `ProductForm.tsx` is now 590 lines (was 1216), with eight extracted sections in
  `src/pages/inventory/product-form/sections/` (Identity, Inventory Unit,
  Lot/Expiry, Pricing, Inventory Tracking, Purchasing Defaults, GL Accounts,
  Tax Compliance). Phase 6 decomposition genuinely landed.
- Phase 5B artefacts exist: `src/test/architecture/purchasing-terms-single-owner.test.ts`
  and `supabase/tests/supplier_purchasing_terms_test.sql`. The dead browser-side
  `useMOQValidation.ts` is gone — no file in `src/` references it.
- The product SQL suites are present:
  `product_measure_landed_cost_basis_test.sql`,
  `product_packaging_hierarchy_test.sql`,
  `product_identifier_lifecycle_test.sql`, plus the identity/UoM guards.

Confirmed still open:
- Dead state `showAdvancedUoM` remains at `ProductForm.tsx:97` after moving into
  `InventoryUnitSection.tsx` — leftover from the decomposition.
- Phase 8 (the end-to-end verification sweep) has still never been executed:
  typecheck + architecture suite runs exceeded the session budget here and must
  be completed and read in full before this wave can be called done.
- Phase 7 (single product read model) is unstarted.

## Phase 6 close-out

- **Broken build (found this session):** the decomposition left the GL accounts
  seam mistyped. `ProductForm.tsx:525` passes a resolver returning
  `CategoryAccountResolution` where `GlAccountsSection` declares a `string`
  prop, and the section's four call sites then pass a string into an object
  parameter (TS2322 + four TS2559). Fix by typing the section prop as the real
  `CategoryAccountResolution` contract and using its `accountId` /
  `categoryName` fields — do not cast it away.
- Remove the unused `showAdvancedUoM` state from `ProductForm.tsx`.
- Confirm every section still writes only through the `patch` /
  `patchLocalization` seams and that the master form keeps sole ownership of the
  single atomic save (no section may call Supabase directly).


## Phase 7 — Read-model consolidation

One product read model serving list, detail and pickers: packaging hierarchy,
resolved measures (via `resolve_product_measure`) and lifecycle `status` resolved
server-side, so no surface recomputes product truth locally. Repoint
`useProducts`, `useBranchScopedProducts`, the detail panel and the transactional
pickers at it; pickers continue to exclude `is_variant_parent` rows and
non-`active` statuses. No new engine — it composes the existing resolvers.

## Phase 8 — Verification sweep (must actually run, output read in full)

1. `npx tsgo --noEmit`.
2. `bunx vitest run src/test/architecture` — in particular
   `purchasing-terms-single-owner`, `products-status-is-truth`,
   `product-save-single-transaction`, `packaging-master`, `product-variants`.
3. SQL suites: `product_measure_landed_cost_basis_test.sql`,
   `product_packaging_hierarchy_test.sql`,
   `supplier_purchasing_terms_test.sql`,
   `landed_cost_basis_immutability_test.sql`.
4. Browser smoke test: one create saving a nested pack + barcode + weight +
   opening stock, one edit round-trip, and a forced failure proving nothing was
   partially written.

Each is long-running; run them one at a time in the background and read the full
output rather than a truncated tail.

## Rules of engagement (unchanged)

- Migrations only through the migration tool; new functions are `authenticated` +
  `service_role`, `anon` revoked.
- Reuse only: `convert_uom`, `resolve_product_identity`,
  `resolve_product_gl_account`, `publish_business_event`, `resolve_exchange_rate`,
  `cost_layers`, `resolve_supplier_purchasing_terms`. No duplicate engines.
- Master data stays separate from transactional state; product creation never
  creates inventory outside the explicit opening-balance workflow.
- No business logic in the browser; phases run in order and none is left
  partially landed.
