# Product Domain Foundation — Verification Verdict & Continuation

## Phase 1 verification verdict (independent, checked against the live database)

Confirmed genuinely implemented, not merely claimed:

- `product_physical_attributes` exists, keyed per level (`packaging_id` nullable), with the integrity trigger `trg_enforce_physical_attribute_integrity` installed.
- `uom_categories.dimension` exists and is populated for every category (no nulls); the single existing business has both volume and length families seeded, so the forward-only seeder change did not leave a backfill hole here.
- `resolve_product_measure(...)` exists as the single read seam and does what the notes claim: exact level, then base-unit x pack size fallback, then `convert_uom`.
- `landed_cost_allocate_voucher` really allocates on weight and volume through that seam; the old hard refusal for those bases is gone.
- No second measure/UoM conversion implementation was introduced in `src/` — only the editor and the read helper.

Verdict: **Phases 0-2 are substantially real**, with three defects that make them not yet coherent. They are the first work items below.

### Defects found during verification

1. **Not fail-closed on missing reference unit.** `resolve_product_measure` returns the raw captured value when the business has no reference unit for the dimension. Weights captured in different units then get summed as if they were the same unit, and Landed Cost allocates on a meaningless total. It must raise instead.
2. **Non-deterministic target unit.** The reference unit is chosen with `LIMIT 1` over all categories of that dimension. With more than one mass or volume category in a tenant, the allocation basis silently depends on row order.
3. **Allocation ignores the receipt line's packaging level.** `goods_receipt_items` carries `packaging_id` / `display_quantity`, but allocation resolves the base-level measure and multiplies by `quantity_received`. This is only correct if `quantity_received` is always base units; the pairing must be proven by test and made explicit, otherwise case receipts are weighted wrongly.
4. **Phase 2 GL residue is still open** (as the notes admitted): no landed-cost function references `resolve_product_gl_account`; capitalization still uses the generic posting-account resolver.
5. **No pgTAP coverage** for any of the above.

## Work plan

### Phase 2R — Close Phase 2 properly
- Make `resolve_product_measure` fail closed: raise a named exception when no reference unit exists for the dimension, and when a tenant has more than one category for a dimension resolve the target deterministically (business-configured reference, then oldest category) rather than by `LIMIT 1`.
- Route landed-cost capitalization through the `resolve_product_gl_account` ladder (ADR 0122) instead of `resolve_posting_account`.
- Resolve physical measures at the receipt line's own packaging level, falling back to base x pack size, so a case receipt weighs a case.
- pgTAP for these three: missing reference unit refuses, mixed-unit products reconcile after conversion, weight/volume allocation totals equal the voucher amount to the cent, and a voucher with one unmeasured product refuses naming that product.

### Phase 3 — Packaging structure (as originally scoped)
`parent_packaging_id`, a shipping-role marker, cycle-safe depth validation, and a trigger asserting a child's `qty_in_base_uom` is consistent with its parent's multiplier. Flat `qty_in_base_uom` stays the canonical arithmetic field so every existing consumer keeps working.

### Phase 4 — `upsert_product_atomic`
One server command owning product master + identifiers + packaging + physical attributes in a single transaction, replacing the sequential client-side writes in `ProductForm.tsx` (including the post-save physical-attribute commit, which today can leave a product saved with attributes lost). Writes keep using the existing identity write seam; no new engines.

### Phase 5 — Ownership cleanup
Product lifecycle (`status` / `archived_at` — neither column exists today, so archive is not modelled), SKU uniqueness at the right scope, move the eight `etims_*` columns off `products` into the localization pack, and emit `product.updated` / `product.archived` through `publish_business_event`.

### Phase 6 — UI decomposition
Split `ProductForm.tsx` (1150 lines) into per-facet sections over the Phase 4 command. Presentation only; no business rules in the browser.

### Phase 7 — Test hardening
pgTAP for tenant isolation, historical immutability and snapshots, packaging consistency; architecture tests pinning the single measure seam and the single write command; a Landed Cost integration test on both physical bases.

### Appended from this review (not in the previous plan)
- **Measurement snapshots.** Editing a product weight today retroactively changes how an already-allocated landed-cost voucher would compute. Decide and implement where the allocation basis is snapshotted so posted history cannot change meaning.
- **Blocking policy.** Define, as configuration rather than code, whether a product without physical attributes may be purchased or received at all, instead of only failing at allocation time.
- **Supplier-product relationship** (MOQ, lead time, supplier UoM/packaging) was in the parent prompt and appears in no phase. Audit whether a canonical supplier-product entity exists before Phase 5 closes, and record the verdict.

## Rules of engagement (unchanged)
No new engines — reuse `convert_uom`, `resolve_product_identity`, `resolve_product_gl_account`, `publish_business_event`, `resolve_exchange_rate`, `cost_layers`. No business logic in the browser. Master data stays separate from transactional state. Product creation never creates inventory outside the explicit opening-balance workflow. Phases run in order; none is left partially landed.
