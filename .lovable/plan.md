# Purchases Domain — Product / UoM / Packaging / Inventory Consumer Audit

**Authoritative engineering record for this wave.** Continue from "Current active phase". Do not repeat completed investigation. Phase 0 findings and the locked scope boundary live in the archived plan `.lovable/plan/purchases-domain-product-uom-packaging-inventory-consumer-au-2026-08-15.md` — read it before doing anything.

---

## Current active phase

**Phase 2 — Server authority sweep across all Purchases write paths.** (Phase 1 landed.)

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

## Phase 2 — Server authority sweep (ACTIVE, not started)

Objective: no Purchases RPC or table write may accept a base quantity the server did not derive.

Work items:
1. Enumerate every Purchases write path (`usePurchaseOrders`, `useBills`, `purchaseReturnRpcs`, `requisitionRpcs`, RFQ writers, `dispatchGoodsReceipt`, `landedCostRpcs`) and record, per path, whether it sends `display_quantity` + provenance or only a base `quantity`.
2. For RPCs that take `quantity` arguments (`record_goods_receipt_line`, `create_goods_receipt`, `convert_rfq_to_po_atomic`, purchase-return creator), confirm the RPC either re-derives through `resolve_line_base_quantity` or writes through the normalized line tables. Fix at the RPC boundary, not with more client validation.
3. Confirm no Purchases client file computes a persisted total/base quantity (guard already in place; extend it to `display_quantity * factor` patterns if offenders appear).
4. Verify `unit_price` semantics per line: price is per **base** unit vs per **pack** must be unambiguous and server-stamped (flag as Phase 9 dependency if unresolved).

## Phase roadmap

3 supplier terms consumption · 4 requisition→RFQ→PO fidelity (incl. pack entry UI) · 5 PO→receiving · 6 packaging vs handling unit · 7 returns · 8 landed cost · 9 pricing ownership · 10 bills/3-way match/Finance boundary · 11 contracts vs supplier_item_terms · 12 multi-branch · 13 concurrency/idempotency · 14 events · 15 projections · 16 scenarios A–H.

---

## Technical notes

- Triggers are `SECURITY DEFINER`, `SET search_path = public`; normalizers named `a_*` so they precede validators.
- Guards land in `supabase/tests/` + `src/test/architecture/`.
- Deprecated fallbacks (`products.min_order_quantity`, `order_quantity_increment`, `cost_price`) stay; Purchases must stop *reading* them (Phase 3).
- `src/test/inventory/enrollment-workflow.test.tsx` is slow/flaky in this sandbox and unrelated to this wave.
