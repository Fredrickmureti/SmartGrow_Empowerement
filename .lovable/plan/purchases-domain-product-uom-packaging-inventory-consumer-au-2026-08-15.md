# Purchases Domain — Product / UoM / Packaging / Inventory Consumer Audit

**This file is the authoritative engineering record for this wave.** Future agents: read it, continue from "Current active phase", do not repeat completed investigation, do not reopen verified items without contradicting evidence.

Wave: Purchases as a *consumer* of the canonical Product → UoM → Packaging → Inventory → Warehouse → Valuation contracts. Not a Finance/WMS/Product redesign.

Related records (do not duplicate): `.lovable/procurement-domain-audit.md` (P0–P3 procurement build log), ADR 0141 (supplier-owned purchasing terms), ADR 0102 (PO lifecycle & commitment), `docs/audit/purchases-verdict.md` (branch isolation).

---

## Current active phase

**Phase 1 — The purchase quantity contract** (Phase 0 complete, findings below).

---

## Scope boundary decision (locked)

| Area | In this wave | Rationale |
|---|---|---|
| Requisitions, RFQs, Purchase Orders, Goods Receipt interaction, Returns, Supplier terms, Price Lists, Landed Cost orchestration, Contracts (terms only) | **Yes** | They carry the purchase quantity/terms contract. |
| Bills, Credit Notes | **Boundary only** — verify that quantity provenance reaching AP is canonical; three-way match state is procurement-owned (`bill_match_results`, `bill_grn_matches`), AP posting/payment stays Finance-owned. |
| Statements, Aged Payables, AP Reconciliation, Insights, Overview | **No** (Phase 15 re-check only) | Finance-owned projections; only revisit if fed wrong purchasing facts. |
| Expenses | **No** | Employee/finance expense workflow, no product line quantity contract. |

---

## Phase 0 — Upstream contract verification (COMPLETE)

Evidence gathered from live `information_schema`, `pg_trigger`, `pg_proc` and source reads.

| Contract | Canonical owner | Purchases consumer | Verdict | Evidence |
|---|---|---|---|---|
| Product identity / base UoM | `products.base_uom_id`, `units_of_measure` | read inside server triggers | ✅ | `_uom_normalize_line`, `enforce_line_uom_consistency` both resolve `products.base_uom_id` |
| UoM conversion | `convert_uom()` + category coherence check | server-side only | ✅ | `enforce_line_uom_consistency` rejects cross-category `display_uom_id` (errcode 23514) |
| Packaging + `qty_in_base_uom` | `product_packaging` | PO/GRN lines | ✅ for PO/GRN | `trg_uom_normalize_po_items`, `trg_uom_normalize_grn_items` |
| Canonical base resolver | `resolve_line_base_quantity(...)` | PO lines only | ⚠ partial | PO trigger calls it; GRN trigger re-implements the arithmetic inline; bill/return/RFQ/requisition lines never call it |
| Frozen UoM snapshot (`uom_snapshot_pack_name/factor/base_code`) | `enforce_line_uom_consistency` | PO, GRN, bill, return lines | ✅ where columns exist | columns present on those 4 line tables; absent on `rfq_items`, `purchase_requisition_items` |
| Supplier purchasing terms | `supplier_item_terms` + `resolve_supplier_purchasing_terms` / `validate_supplier_order_quantity` (ADR 0141) | **no Purchases caller found yet** | ⚠ | `supplier_item_terms` has `purchase_uom_id`, `min_order_qty`, `price_break_tiers`, `currency_code`; single client seam is `src/features/products/purchasing/supplierPurchasingTerms.ts` — Phase 3 must confirm PO/RFQ entry consumes it |
| Inventory / receiving | `create_goods_receipt` → outbox → `wms_apply_gr_stock` | Purchases calls the wrapper | ✅ (re-verify in Phase 5) | procurement audit P0 "Great Split" |
| Valuation / landed cost | `landed_cost_*` engine, cost layers | orchestration in `src/features/purchases/landed-costs` | ⏸ Phase 8 |

**No new Product/UoM/Inventory engine may be created in this wave.**

---

## Phase 1 — Purchase quantity contract (ACTIVE)

### Findings

**F1.1 — Purchase Order lines: ✅ correct.**
`purchase_order_items` carries `display_quantity`, `display_uom_id`, `packaging_id`, base `quantity`, plus the three frozen snapshot columns. `trg_uom_normalize_po_items` (SECURITY DEFINER) recomputes `quantity` from `display_quantity × packaging/UoM` via `resolve_line_base_quantity` on INSERT and on any change to the display triple. A browser-supplied `quantity` is therefore overwritten, not trusted. `enforce_line_uom_consistency` additionally rejects packaging that belongs to another product and cross-category UoM.
*Required action:* none.

**F1.2 — Goods receipt lines: ⚠ second conversion implementation.**
`_uom_normalize_line_grn` does the same job for `quantity_received` but re-derives the arithmetic inline (`display_quantity × qty_in_base_uom`, else `convert_uom`) instead of calling `resolve_line_base_quantity`. Result is currently equivalent, but it is a duplicate engine and will drift (e.g. it does not honour resolver-side rounding/precision rules).
*Required action:* rewrite `_uom_normalize_line_grn` as a thin wrapper over `resolve_line_base_quantity`, keeping the `quantity_received` column mapping. Add SQL test asserting PO line and GRN line produce identical base quantities for the same display triple.
*Canonical owner:* Inventory UoM engine. *Implement now:* yes (Phase 1).

**F1.3 — Bill lines and purchase return lines: ⚠ browser is the arithmetic author.**
`bill_items` and `purchase_return_items` have the full column set but **only** `enforce_line_uom_consistency` — a *validator*, not a normalizer. It raises when `quantity ≠ display_quantity × factor`, so a wrong value is refused, but the base quantity is still computed in the browser and merely checked; when `display_quantity` is NULL nothing is checked at all, and there is no server path that derives base from display. `src/hooks/useBills.ts` comments claim "DB trigger normalizes" — that comment is wrong.
*Why it matters:* returns move inventory; a NULL-display bill/return line bypasses the check entirely.
*Required action:* attach a normalize trigger (same wrapper as F1.2) to `bill_items.quantity` and `purchase_return_items.quantity`; correct the misleading comment in `useBills.ts`/`purchaseReturnRpcs.ts`.
*Implement now:* yes (Phase 1).

**F1.4 — RFQ lines and requisition lines: ⚠ no packaging, no snapshot.**
`rfq_items` and `purchase_requisition_items` carry only `quantity` + `uom_id`. They cannot represent "10 bags of 50 kg" — the demand and the sourcing request lose the purchasing unit, so the PO conversion (F1.1) starts from a re-entered unit rather than from what was requested/quoted. Enterprise practice (SAP PR/RFQ, Oracle, Odoo) keeps order-unit + conversion on the requisition and RFQ line.
*Required action:* add `packaging_id`, `display_quantity`, `display_uom_id` and the three snapshot columns to both tables; attach the normalize + consistency triggers; carry them through `convert_rfq_to_po_atomic` and the requisition→PO path (Phase 4 verifies the carry-through).
*Implement now:* yes, schema + triggers in Phase 1; transition fidelity in Phase 4.

**F1.5 — Inbound shipment lines: note only.**
`inbound_shipment_items` has `expected_packaging_id` + `display_quantity`/`display_uom_id` but a differently named packaging column. Verify in Phase 5 that the expected-supply view and receiving read it consistently; no action in Phase 1.

### Phase 1 exit criteria
1. One conversion implementation (`resolve_line_base_quantity`) behind every purchasing line table.
2. No purchasing line table can persist a base quantity authored by the browser.
3. RFQ and requisition lines can express packaged purchasing units.
4. SQL test `supabase/tests/purchases_quantity_contract_test.sql` proves Scenarios A/B/C at line level.
5. Architecture test asserting no Purchases client file multiplies by `qty_in_base_uom` to produce a persisted quantity.

---

## Phase roadmap (not yet started)

| Phase | Subject | State |
|---|---|---|
| 2 | Server authority sweep across all Purchases write paths (RPC signatures accepting base quantities) | ⏸ after 1 |
| 3 | Supplier terms consumption (`resolve_supplier_purchasing_terms` at PO/RFQ entry; kill reads of `products.cost_price` / `min_order_quantity` in Purchases) | ⏸ |
| 4 | Requisition → RFQ → Quote → PO fidelity (qty, pack, UoM, price, currency, terms) | ⏸ |
| 5 | PO → receiving: partial/over/under receipt, outstanding in supplier unit, idempotency | ⏸ |
| 6 | Product packaging vs warehouse handling unit boundary | ⏸ |
| 7 | Returns reuse the receiving quantity contract | ⏸ |
| 8 | Landed cost boundary (consume, never duplicate valuation/GL) | ⏸ |
| 9 | Purchase pricing ownership (`vendor_pricelists` vs `supplier_item_terms` vs contracts) | ⏸ |
| 10 | Bills / three-way match / Finance boundary | ⏸ |
| 11 | Supplier contracts vs supplier_item_terms duplication | ⏸ |
| 12 | Multi-branch / multi-tenant scope (build on `docs/audit/purchases-verdict.md`) | ⏸ |
| 13 | Concurrency & idempotency | ⏸ |
| 14 | Events on the existing outbox only | ⏸ |
| 15 | Reporting/projections re-check | ⏸ |
| 16 | Scenarios A–H end to end | ⏸ |

---

## Technical notes

- Migrations: one per phase, `CREATE TABLE`→`GRANT`→`RLS`→`POLICY` order; triggers are `SECURITY DEFINER` with `SET search_path = public`.
- New guards land under `supabase/tests/` and `src/test/architecture/`.
- Deprecated fallbacks (`products.min_order_quantity`, `order_quantity_increment`, `cost_price`) stay in place; Purchases must stop reading them directly (Phase 3), not drop them.
