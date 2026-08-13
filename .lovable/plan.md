# Product Domain — Foundation Wave: Live Status

Authoritative status for the Product Domain foundation wave. Roadmap and audit findings live in
`.lovable/plan/product-domain-foundation-audit-engineering-wave-2026-08-13.md` (approved). This file
tracks *where we are*. Execution is chronological: Phase N is finished and coherent before Phase N+1.

## Roadmap status

| Phase | Scope | Status |
|---|---|---|
| 0 | ADR 0140 — ownership matrix, scope matrix, event lifecycle | **Done** |
| 1 | Physical attributes foundation (weight / volume / dimensions) | **Done — needs independent verification** |
| 2 | Landed Cost weight + volume allocation via canonical read seam | **Done — needs independent verification** |
| 3 | Nested packaging structure (`parent_packaging_id`, shipping role) | **Next — not started** |
| 4 | `upsert_product_atomic` single write command | Pending |
| 5 | Ownership cleanup (SKU uniqueness, archive lifecycle, terms/pricing/localization) | Pending |
| 6 | UI decomposition of `ProductForm.tsx` (1150 lines) | Pending |
| 7 | pgTAP + architecture + Landed Cost integration tests | Pending |

**Currently active phase: none — Phase 2 closed out, Phase 3 not yet opened.**

## Completed and shipped

**Phase 0 — Architecture report**
- `docs/adr/0140-product-domain-foundation.md`. Decisions: the Product domain owns physical facts;
  measurements are stored per level (base unit = `packaging_id IS NULL`, or a specific packaging row);
  every measure carries a `units_of_measure` FK (no `weight_kg`-style columns); `gross_weight` is
  server-derived/validated from net + tare; all reads go through one seam.

**Phase 1 — Physical attributes**
- `uom_categories.dimension` added with a CHECK over `count | mass | volume | length | area | other`.
- `seed_default_uom_for_business` extended to provision Volume (L, mL, m³, cm³) and Length
  (cm, mm, m, in, ft) families — previously only Count and Weight were seeded.
- `product_physical_attributes` keyed by `(product_id, packaging_id NULLABLE)`.
- `trg_enforce_physical_attribute_integrity`: mass measures require a mass UoM, volume a volume UoM,
  dimensions a length UoM; cross-tenant / cross-business units rejected; gross must equal net + tare
  within 0.5% tolerance.
- Legacy `products.tare_weight` / `weight_unit` (free text) migrated into base-level tare weights and
  retained read-only for POS scale flows.
- UI: `UomSelect` gained a `dimension` filter; `src/components/products/ProductPhysicalAttributesEditor.tsx`
  plus `src/features/products/physical/physicalAttributes.ts`; wired into `src/pages/inventory/ProductForm.tsx`
  via an imperative post-save `commit`.

**Phase 2 — Landed Cost integration**
- `resolve_product_measure(...)` is the single read seam: packaging-level row → base unit × pack size →
  `convert_uom` to the requested target UoM.
- `landed_cost_allocate_voucher` now allocates on `weight` and `volume` bases (the previous hard
  `RAISE EXCEPTION` is gone) and **fails closed**: missing master data raises an exception naming the
  offending products rather than silently falling back to value basis.
- TypeScript typecheck clean after the wave.

## Known gaps still open (carried from the audit)

- Phase 1/2 have **no pgTAP coverage yet** (deferred to Phase 7 by design, but this is the largest
  outstanding risk on the work just shipped).
- Landed Cost capitalization still calls `resolve_posting_account` instead of the
  `resolve_product_gl_account` ladder (ADR 0122) — scoped in Phase 2's charter, **not yet done**.
  Close this before Phase 3 so Phase 2 is genuinely coherent.
- `ProductForm.tsx` still performs sequential non-atomic client writes; the physical-attribute commit
  is one more child write on that same unsafe path. Phase 4 removes this.
- Packaging remains flat; no level can express its own weight/volume/dimensions relationship to a parent.
- No unique `(organization_id, sku)`; no `status` / `archived_at`; `etims_*` still on `products`;
  no `product.updated` / `product.archived` events.

## Instructions for the next agent

1. **Verify before you build.** Do not open Phase 3 until Phases 1 and 2 are confirmed correct:
   - Read `docs/adr/0140-product-domain-foundation.md` and the two migrations
     `supabase/migrations/20260813225010_*.sql` and `20260813225210_*.sql`.
   - Confirm in the live database: `product_physical_attributes` exists with the expected keys and
     constraints, `uom_categories.dimension` is populated for every existing category, and
     `seed_default_uom_for_business` really provisions volume and length for existing businesses
     (backfill if older businesses were missed — a forward-only seeder change is not a backfill).
   - Exercise `resolve_product_measure` directly in SQL for: base-level only, packaging-level override,
     packaging fallback via pack size, cross-UoM conversion, and missing data.
   - Exercise `landed_cost_allocate_voucher` on weight and volume bases: totals must reconcile exactly
     to the voucher amount (no rounding leakage), and a voucher containing one product without
     measurements must refuse with the product named.
   - Confirm the integrity trigger rejects: length UoM on a weight measure, a unit from another
     business, and gross ≠ net + tare beyond tolerance.
   - Confirm no second measure-conversion or UoM implementation was introduced anywhere in `src/`
     (`convert_uom` and `resolve_product_measure` are the only seams).
   Report the verification verdict explicitly before writing code.
2. **Close Phase 2 residue**: route landed-cost capitalization through `resolve_product_gl_account`.
3. **Then resume chronologically at Phase 3 — Packaging structure**: `parent_packaging_id`,
   shipping-role marker, cycle-safe depth validation, and a trigger asserting a child's
   `qty_in_base_uom` is consistent with its parent's multiplier. Keep flat `qty_in_base_uom` as the
   canonical arithmetic field so every existing consumer keeps working.
4. **Rules of engagement**: no new engines (reuse `convert_uom`, `resolve_product_identity`,
   `resolve_product_gl_account`, `publish_business_event`, `resolve_exchange_rate`, `cost_layers`);
   no business logic in the browser; master data stays separate from transactional state; product
   creation must never create inventory outside the explicit opening-balance workflow. Do not skip
   ahead to Phase 4+, do not start unrelated domains, and do not leave a phase partially landed.
