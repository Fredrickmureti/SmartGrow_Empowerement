# Purchases Domain — Product / UoM / Packaging / Inventory Consumer Audit

**Authoritative engineering record for this wave.** Continue from "Current active phase". Do not repeat completed investigation. Phase 0 findings and the locked scope boundary live in the archived plan `.lovable/plan/purchases-domain-product-uom-packaging-inventory-consumer-au-2026-08-15.md` — read it before doing anything.

---

## Current active phase

**Phase 4 — requisition → RFQ → PO fidelity (incl. pack entry UI).** (Phases 0–3 landed and verified.)

### Instructions for the next agent

1. **Verify Phase 3 before extending it.** Confirm in the live database that `resolve_supplier_purchasing_terms` calls `_resolve_supplier_role_id` (party `contacts.id` → `suppliers.id`), that both purchasing-terms functions are still `SECURITY DEFINER`, tenant-gated and revoked from `anon`, and that `validate_supplier_order_quantity` still reads terms only through the resolver. Run `supabase/tests/supplier_purchasing_terms_test.sql` (sections 1–7) if psql access is available, and `bunx vitest run src/test/architecture/purchasing-terms-single-owner.test.ts` (5 tests, must be green).
2. Then start Phase 4. Do not open unrelated areas, and do not leave a phase half-shipped.

---

## Phase 1 — Purchase quantity contract — ✅ COMPLETE (2026-08-15)

Landed:

1. **One conversion engine.** `_uom_normalize_line()` rewritten as a generic, jsonb-driven BEFORE INSERT/UPDATE trigger that maps the base-quantity column per table (`quantity_received` for GRN, `quantity_delivered`, `quantity_sent`, else `quantity`) and delegates the arithmetic to `resolve_line_base_quantity`. It derives `display_quantity` when the caller sent only base units, and stamps `display_uom_id` + free-text `uom_snapshot`.
2. **Duplicate engine deleted.** `_uom_normalize_line_grn()` and `trg_uom_normalize_grn_items` dropped (F1.2).
3. **Normalizer attached** to `goods_receipt_items`, `bill_items`, `purchase_return_items`, `rfq_items`, `purchase_requisition_items` as `a_uom_normalize_*` (the `a_` prefix makes normalization run before the alphabetically later `enforce_line_uom_consistency` validator). `purchase_order_items` keeps its existing `trg_uom_normalize_po_items`. Bill and return lines can no longer persist a browser-authored base quantity (F1.3).
4. **Demand/sourcing lines carry the purchasing unit** (F1.4): `rfq_items` and `purchase_requisition_items` gained `packaging_id`, `display_quantity`, `display_uom_id`, `uom_snapshot`, `uom_snapshot_pack_name/factor/base_code`; backfilled `display_quantity := quantity`, `display_uom_id := uom_id`; `enforce_line_uom_consistency` attached for coherence + frozen snapshot stamping.
5. **Guards**: `supabase/tests/purchases_quantity_contract_test.sql` (normalizer attached everywhere, no second engine, new columns present, Scenarios A/B/C arithmetic, Scenario E refusal) and `src/test/architecture/purchases-quantity-server-owned.test.ts` (green — no packaging-factor arithmetic in Purchases client code).
6. Misleading "DB trigger normalizes" / bare `quantity` comments corrected in `src/hooks/useBills.ts` and `src/lib/purchases/purchaseReturnRpcs.ts`.

Not done in Phase 1 (deliberate): legacy `rfq_items.uom_id` / `purchase_requisition_items.uom_id` retained as the legacy column, superseded by `display_uom_id`; drop only after Phase 4 proves nothing reads it. UI for entering packs on requisition/RFQ lines (`RequisitionLineRow`, RFQ line editor) is **not** yet wired — Phase 4 work item.

Open note carried forward (F1.5): `inbound_shipment_items` names its pack column `expected_packaging_id` and has no normalizer — verify against the expected-supply view in Phase 5.

---

## Phase 2 — Server authority over quantities — ✅ COMPLETE (2026-08-15)

Objective met: no Purchases write path validates policy against, or persists, a base quantity the browser authored.

Findings and fixes (one migration):

- **F2.1 (security-relevant, fixed).** `_pret_write_lines` validated the client's `quantity` against `quantity_returnable`, while the newly attached normalizer re-derived the stored quantity from `display_quantity × pack factor`. A return could pass the guard at 1 and persist 50. The writer now resolves the base quantity through `resolve_line_base_quantity` *first*, validates the returnable guard and prices the line off that number — the guard and the stored row cannot disagree.
- **F2.2 (fixed).** `create_goods_receipt` re-implemented `base / pack factor` in SQL. Removed; the normalizer derives whichever of `quantity_received` / `display_quantity` the caller omitted.
- **F2.3 (fixed).** `create_purchase_requisition` ignored the Phase-1 columns. It now maps `packaging_id`, `display_quantity`, `display_uom_id` (falling back to `uom_id`). `RequisitionLineInput` in `src/features/purchases/requisitions/requisitionRpcs.ts` exposes the same optional fields.
- **F2.4 (fixed).** `requisition_create_rfq` dropped the purchasing unit. It now carries `packaging_id` + `display_uom_id`; `display_quantity` is deliberately left NULL so the normalizer derives it from remaining base demand.
- **F2.5 (fixed).** `convert_po_to_bill_atomic` billed in loose base units. `packaging_id` / `display_uom_id` now travel from the PO line onto the bill line.
- **F2.6 (verified, no change).** `update_po_items_atomic` already passes pack provenance and writes through the normalized table.

Guard: `supabase/tests/purchases_server_authority_test.sql` (resolver precedes the returnable guard; no RPC divides by a pack factor; provenance survives every hop; all six line tables keep the normalizer). `src/test/architecture/purchases-quantity-server-owned.test.ts` green.

Carried into later phases:
- **F2.7 → Phase 9.** `rfq_convert_awards_to_po` writes `unit_price` from `rfq_award_items` while `awarded_quantity` is in the awarded UoM; whether price is per base unit or per awarded unit is still ambiguous and must be settled with pricing ownership.
- **F2.8 → Phase 5.** `inbound_shipment_items` (`expected_packaging_id`, no normalizer) still outside the contract.

## Phase 3 — Supplier-specific purchasing terms — ✅ COMPLETE (2026-08-15)

Objective met: Purchases surfaces consume `resolve_supplier_purchasing_terms` / `validate_supplier_order_quantity` (ADR 0141) instead of re-deriving MOQ, increment, lead time or purchase UoM, and no Purchases surface reads the deprecated product-level defaults.

Findings and fixes:

- **F3.1 (blocking, fixed in a migration).** The resolver keyed `p_supplier_id` on `suppliers.id` (role) while every purchasing document carries `vendor_id → contacts.id` (party, ADR-0079). Purchases literally could not consult terms without inventing a party→role hop in the browser. Added `public._resolve_supplier_role_id(business, party_or_role_id)` (SECURITY DEFINER, `authenticated`/`service_role` only) and made `resolve_supplier_purchasing_terms` accept either identifier. `validate_supplier_order_quantity` inherits this because it reads terms only through the resolver.
- **F3.2 (fixed).** No Purchases surface consulted terms at all. New Purchases adapter over the single client seam: `src/features/purchases/purchasingTerms/purchaseLineTerms.ts` — `validatePurchaseLinesAgainstTerms`, `validatePurchaseLineQuantity`, `resolvePurchaseLineDefaults`, `summarisePurchaseLineRefusals`. It contains no arithmetic; every verdict and every default comes from the server, and refusal copy comes from `describeOrderQuantityVerdict`.
- **F3.3 (fixed).** `PurchaseOrderCreatePage`, `PurchaseOrderEditPage` and `RequisitionCreatePage` now (a) seed a newly picked line with the resolved minimum order quantity, purchase UoM (`display_uom_id`) and supplier unit price, and (b) **refuse submission** with per-line copy when any line is below MOQ or off-increment. The requisition validates per line against that line's `suggested_supplier_id`.
- **F3.4 (verified, no change).** `products.min_order_quantity` / `order_quantity_increment` are read only by the product master form; the guard test still asserts no comparison or modulo anywhere in app code.

Guards: `supabase/tests/supplier_purchasing_terms_test.sql` gained section 7 (party→role hop exists, helper not executable by `anon`, resolver uses it); `src/test/architecture/purchasing-terms-single-owner.test.ts` gained two cases (the three Purchases surfaces call the validator; Purchases code reaches terms only through the Purchases adapter, never the products seam directly). Both green, `tsgo -p tsconfig.app.json` clean.

Deliberately not done in Phase 3: RFQ line entry has no quantity/MOQ gate yet — RFQ quantities are a *request for pricing*, not a commitment, and the pack-entry UI for RFQ/requisition lines is the Phase 4 work item; award → PO conversion is where the commitment (and therefore the MOQ gate) belongs. Reorder / replenishment recommendation surfaces sit in Inventory, outside this wave's scope boundary.

## Phase roadmap

**4 (active)** requisition→RFQ→PO fidelity (incl. pack entry UI, MOQ gate at award→PO) · 5 PO→receiving (+F2.8) · 6 packaging vs handling unit · 7 returns · 8 landed cost · 9 pricing ownership (+F2.7) · 10 bills/3-way match/Finance boundary · 11 contracts vs supplier_item_terms · 12 multi-branch · 13 concurrency/idempotency · 14 events · 15 projections · 16 scenarios A–H.


---

## Technical notes

- Triggers are `SECURITY DEFINER`, `SET search_path = public`; normalizers named `a_*` so they precede validators.
- Guards land in `supabase/tests/` + `src/test/architecture/`.
- Deprecated fallbacks (`products.min_order_quantity`, `order_quantity_increment`, `cost_price`) stay; Purchases must stop *reading* them (Phase 3).
- `src/test/inventory/enrollment-workflow.test.tsx` is slow/flaky in this sandbox and unrelated to this wave.
