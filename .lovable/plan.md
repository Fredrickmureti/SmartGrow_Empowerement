# Purchases Domain — Product / UoM / Packaging / Inventory Consumer Audit

**Authoritative engineering record for this wave.** Continue from "Current active phase". Do not repeat completed investigation. Phase 0 findings and the locked scope boundary live in the archived plan `.lovable/plan/purchases-domain-product-uom-packaging-inventory-consumer-au-2026-08-15.md` — read it before doing anything.

---

## Current active phase

**Phase 3 — supplier-specific purchasing terms consumption.** (Phases 0–2 landed and verified.)

### Instructions for the next agent

1. **Verify Phase 2 before extending it.** Re-read `_pret_write_lines`, `create_goods_receipt`, `create_purchase_requisition`, `requisition_create_rfq` and `convert_po_to_bill_atomic` in the live database (`pg_get_functiondef`). Confirm: the return writer resolves the base quantity *before* the returnable guard; no purchasing RPC divides by a pack factor; `packaging_id` / `display_uom_id` are carried at every document hop; all six purchasing line tables still hold a `_uom_normalize_line` trigger. `supabase/tests/purchases_server_authority_test.sql` asserts exactly this — run it if psql access is available.
2. Only then start Phase 3. Do not open unrelated areas, and do not leave a phase half-shipped.


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

## Phase 3 — Supplier-specific purchasing terms (NEXT, not started)

Objective: purchasing surfaces consume `resolve_supplier_purchasing_terms` / `validate_supplier_order_quantity` (ADR 0141) instead of re-deriving MOQ, increment, lead time or purchase UoM.

Work items:
1. Inventory every Purchases surface that decides a quantity or a supplier default (PO line entry, requisition line, RFQ line, reorder/replenishment recommendation) and record what it reads today.
2. Route each through the single client seam `src/features/products/purchasing/supplierPurchasingTerms.ts`; no surface may read `products.min_order_quantity` / `order_quantity_increment` directly.
3. Make the PO/requisition line entry refuse a below-MOQ / off-increment quantity using `describeOrderQuantityVerdict` copy, and default the line's `packaging_id` / `display_uom_id` from the resolved `purchase_uom_id`.
4. Extend `src/test/architecture/purchasing-terms-single-owner.test.ts` to cover the Purchases surfaces.

## Phase roadmap

4 requisition→RFQ→PO fidelity (incl. pack entry UI) · 5 PO→receiving (+F2.8) · 6 packaging vs handling unit · 7 returns · 8 landed cost · 9 pricing ownership (+F2.7) · 10 bills/3-way match/Finance boundary · 11 contracts vs supplier_item_terms · 12 multi-branch · 13 concurrency/idempotency · 14 events · 15 projections · 16 scenarios A–H.


---

## Technical notes

- Triggers are `SECURITY DEFINER`, `SET search_path = public`; normalizers named `a_*` so they precede validators.
- Guards land in `supabase/tests/` + `src/test/architecture/`.
- Deprecated fallbacks (`products.min_order_quantity`, `order_quantity_increment`, `cost_price`) stay; Purchases must stop *reading* them (Phase 3).
- `src/test/inventory/enrollment-workflow.test.tsx` is slow/flaky in this sandbox and unrelated to this wave.
