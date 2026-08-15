# Purchases Domain — Product / UoM / Packaging / Inventory Consumer Audit

**Authoritative engineering record for this wave.** Continue from "Current active phase". Do not repeat completed investigation. Phase 0 findings and the locked scope boundary live in `.lovable/plan/purchases-domain-product-uom-packaging-inventory-consumer-au-2026-08-15.md` — read it before doing anything.

---

## Verification verdict on Phases 1–3 (2026-08-15, incoming engineer)

Claims were re-checked directly against the live database and the codebase, not against the previous notes.

| Claim | Verdict | Evidence |
|---|---|---|
| One conversion engine, `_uom_normalize_line`, jsonb-driven | ✅ | single `_uom_normalize_line` proc, `SECURITY DEFINER`; no `_uom_normalize_line_grn` remains |
| Normalizer attached to GRN / bill / return / RFQ / requisition lines with `a_` prefix | ✅ | `pg_trigger`: `a_uom_normalize_{grn,bill,purchase_return,rfq,requisition}_items` all present and ordered before `enforce_line_uom_consistency` |
| `purchase_order_items` "keeps its existing trigger" — therefore fine | ❌ **wrong** | trigger is `trg_uom_normalize_po_items`; Postgres fires triggers in name order, so on PO lines `enforce_line_uom_consistency` runs **before** normalization (see F4.0) |
| Party→role hop for supplier terms | ✅ | `_resolve_supplier_role_id(uuid,uuid)` `SECURITY DEFINER`; `resolve_supplier_purchasing_terms` calls it and falls back product_default → system_default with source labels |
| Terms functions tenant-gated | ✅ | resolver raises `SUPPLIER_TERMS_FORBIDDEN` via `user_has_business_access`; `validate_supplier_order_quantity` reads terms only through the resolver |
| Purchases adapter is the only client seam | ✅ | `src/features/purchases/purchasingTerms/purchaseLineTerms.ts` present; guard tests present |
| Phase 1/2/3 guard tests exist | ✅ | `supabase/tests/purchases_quantity_contract_test.sql`, `purchases_server_authority_test.sql`, `supplier_purchasing_terms_test.sql`, `src/test/architecture/purchases-quantity-server-owned.test.ts`, `purchasing-terms-single-owner.test.ts` |

**Net:** Phases 1 and 3 stand. Phase 2's headline ("no Purchases write path persists a browser-authored base quantity") is **not true for the PO line table** — the highest-volume purchasing line in the system. Reopened as F4.0 inside the active phase rather than re-running Phase 2.

---

## Current active phase

**Phase 4 — requisition → RFQ → PO fidelity, including the trigger-order defect and pack entry UI.**

### Work items (in order)

**F4.0 — ❌ PO lines: validator runs before normalizer.** `enforce_line_uom_consistency` sorts alphabetically before `trg_uom_normalize_po_items`, so a PO line that sends `display_quantity = 10` + a 50 kg pack and lets the server derive base units is **rejected** with a UoM-mismatch error before the normalizer can derive it — the client must pre-compute `quantity = 500` for the write to succeed. That is browser-authoritative arithmetic on the central purchasing document.
*Action:* rename the PO normalizer to `a_uom_normalize_po_items` (drop + recreate; same function) so PO lines match every other line table. Extend `purchases_quantity_contract_test.sql` with a case that inserts a PO line supplying only `display_quantity` + `packaging_id` and asserts the stored base quantity.
*Owner:* Purchases (trigger ordering) · *Blocks:* the pack entry UI below.

**F4.1 — ❌ award → PO drops packaging and double-states quantity.** `rfq_convert_awards_to_po` inserts `quantity := ai.awarded_quantity` **and** `display_quantity := ai.awarded_quantity` with `display_uom_id := ai.awarded_uom_id`, and never carries `packaging_id` from the RFQ line. When the award is in a non-base unit the two columns disagree until the normalizer rewrites `quantity` — and with F4.0 unfixed the validator refuses the row outright.
*Action:* carry `packaging_id` from `rfq_items`, pass `display_quantity` + `display_uom_id`/`packaging_id` only and leave `quantity` to the normalizer (fix after F4.0). Header `subtotal`/`tax_amount` must be recomputed from the persisted lines, not from `rfq_award_items.line_total`, once the unit meaning is settled.

**F4.2 — ⏸ awarded unit price meaning (was F2.7).** `ai.unit_price` may be per base unit or per awarded unit; nothing in the schema says which. Do not guess. Settle with pricing ownership in Phase 9 and keep the current behaviour until then; record the resolution here.

**F4.3 — ❌ no pack/unit entry anywhere in Purchases line UI.** `PurchaseOrderCreatePage` / `PurchaseOrderEditPage` render `PricedLineRow` **without** `unitsFor`, so `PackagedQtyCell` never offers a pack or alternate unit; `RequisitionLineRow` has a bare `quantity` `NumericInput` and no pack cell; the RFQ editor uses `RequestLineRow`, whose shape declares `packaging_id` / `display_uom_id` but renders no control for them. Scenarios B and C from the brief are unreachable from the UI: a buyer cannot order "10 bags".
*Action:* introduce a purchasing twin of `useSellableUnits` — a `usePurchasableUnits` seam that returns the same `SellUnitOption[]` shape but seeds the default unit from `resolve_supplier_purchasing_terms.purchase_uom_id` (already surfaced by `resolvePurchaseLineDefaults`). No new arithmetic: the cell stays a preview, the trigger stays authoritative. Wire it into PO create/edit (`unitsFor`), add a `PackagedQtyCell` quantity cell to `RequisitionLineRow`, and add the same cell to `RequestLineRow` for RFQ lines. MOQ/increment validation keeps flowing through the existing Purchases adapter.

**F4.4 — ⚠ MOQ gate missing at the point of commitment.** Phase 3 deliberately left RFQ quantities ungated (a request for pricing is not a commitment) and put the gate on PO create/edit. `rfq_convert_awards_to_po` and requisition→PO conversion bypass both, so a commitment can still be created below MOQ or off-increment.
*Action:* call `validate_supplier_order_quantity` server-side inside the conversion RPCs, refusing with the existing reason codes; the browser must not be the only gate.

**Exit criteria for Phase 4:** entered quantity, entered unit / packaging and canonical base quantity survive requisition → RFQ → award → PO with the supplier-facing quantity still readable on each document; PO lines accept pack-denominated input without client arithmetic; guards green (`purchases_quantity_contract_test.sql`, `purchases_server_authority_test.sql`, `purchases-quantity-server-owned.test.ts`, `purchasing-terms-single-owner.test.ts`).

---

## Phase 1 — Purchase quantity contract — ✅ COMPLETE (2026-08-15, re-verified)

1. **One conversion engine.** `_uom_normalize_line()` — generic jsonb-driven BEFORE INSERT/UPDATE trigger; maps the base-quantity column per table (`quantity_received`, `quantity_delivered`, `quantity_sent`, else `quantity`) and delegates arithmetic to `resolve_line_base_quantity`. Derives `display_quantity` when only base units arrive; stamps `display_uom_id` + `uom_snapshot`.
2. **Duplicate engine deleted** (`_uom_normalize_line_grn`).
3. **Attached** to `goods_receipt_items`, `bill_items`, `purchase_return_items`, `rfq_items`, `purchase_requisition_items` as `a_uom_normalize_*`. PO lines are the exception — see F4.0.
4. **Demand/sourcing lines carry the purchasing unit**: `rfq_items` and `purchase_requisition_items` gained `packaging_id`, `display_quantity`, `display_uom_id`, `uom_snapshot*`; backfilled; consistency validator attached.
5. Guards as listed above.

Deliberately deferred: legacy `rfq_items.uom_id` / `purchase_requisition_items.uom_id` retained, superseded by `display_uom_id`; drop only after Phase 4 proves nothing reads them.

Carried forward (**F1.5 / F2.8 → Phase 5**): `inbound_shipment_items` names its pack column `expected_packaging_id` and has no normalizer — reconcile against the expected-supply view.

## Phase 2 — Server authority over quantities — ⚠ MOSTLY COMPLETE (2026-08-15; PO gap reopened as F4.0)

- **F2.1 (fixed).** `_pret_write_lines` validated the client `quantity` against `quantity_returnable` while the normalizer re-derived the stored quantity — a return could pass the guard at 1 and persist 50. The writer now resolves base quantity through `resolve_line_base_quantity` first, then validates and prices off that number.
- **F2.2 (fixed).** `create_goods_receipt` no longer re-implements `base / pack factor`.
- **F2.3 (fixed).** `create_purchase_requisition` maps `packaging_id`, `display_quantity`, `display_uom_id`.
- **F2.4 (fixed).** `requisition_create_rfq` carries `packaging_id` + `display_uom_id`; `display_quantity` left NULL so the normalizer derives it.
- **F2.5 (fixed).** `convert_po_to_bill_atomic` carries pack provenance onto bill lines.
- **F2.6 (verified).** `update_po_items_atomic` passes pack provenance.
- **F2.7 → F4.2.** Awarded unit-price meaning unresolved.

## Phase 3 — Supplier-specific purchasing terms — ✅ COMPLETE (2026-08-15, re-verified)

- **F3.1 (fixed).** Resolver keyed on `suppliers.id` while documents carry `vendor_id → contacts.id` (ADR-0079). `_resolve_supplier_role_id` added; the resolver accepts either identifier.
- **F3.2 (fixed).** Purchases adapter `src/features/purchases/purchasingTerms/purchaseLineTerms.ts` over the single client seam — no arithmetic, refusal copy from `describeOrderQuantityVerdict`.
- **F3.3 (fixed).** PO create/edit and requisition create seed MOQ / purchase UoM / supplier price and refuse submission per line. Gap at conversion RPCs → F4.4.
- **F3.4 (verified).** Deprecated product-level defaults read only by the product master form.

## Phase roadmap

**4 (active)** requisition→RFQ→PO fidelity (F4.0–F4.4) · 5 PO→receiving (+F1.5/F2.8) · 6 packaging vs handling unit · 7 returns · 8 landed cost · 9 pricing ownership (+F4.2) · 10 bills / 3-way match / Finance boundary · 11 contracts vs `supplier_item_terms` · 12 multi-branch · 13 concurrency / idempotency · 14 events · 15 projections · 16 scenarios A–H.

---

## Technical notes

- Triggers are `SECURITY DEFINER`, `SET search_path = public`; normalizers must be named `a_*` so they precede `enforce_line_uom_consistency` — the validator raises on a base/display mismatch and therefore cannot run first.
- Guards land in `supabase/tests/` + `src/test/architecture/`.
- Deprecated fallbacks (`products.min_order_quantity`, `order_quantity_increment`, `cost_price`) stay as resolver fallbacks; Purchases must not read them.
- `src/test/inventory/enrollment-workflow.test.tsx` is slow/flaky in this sandbox and unrelated to this wave.
