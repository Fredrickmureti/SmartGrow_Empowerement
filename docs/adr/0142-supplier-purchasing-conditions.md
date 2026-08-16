# ADR 0142 — Supplier purchasing conditions: one price authority, governed writes

- **Status**: Accepted (2026-08-16)
- **Extends**: ADR 0141 (supplier-owned purchasing terms), ADR 0101 (single
  governance engine), ADR-0079 (party vs supplier role)

## Context

The screen called "Vendor Price Lists" is not a price list. It is the
**purchasing info record**: the standing conditions a supplier offers for a
product. `supplier_item_terms` already owned it (ADR 0141), but the domain had
gaps that only showed up under real procurement use:

1. `price_break_tiers` was captured and validated, and then **never read** —
   `resolve_supplier_purchasing_terms` returned the flat `unit_price` only.
2. There was **no purchase-side price authority**. Contracts carried prices,
   supplier terms carried prices, products carried a default cost, and nothing
   ranked them; each surface picked for itself.
3. The overlap guard ignored `branch_id`, so a branch-specific condition
   collided with the company-wide one instead of overriding it.
4. The write RPC touched no approval, audit or event engine, although all three
   exist.
5. Purchase order lines snapshotted contract pricing only, so a line priced by
   a supplier condition became unexplainable once the condition changed.

## Decision

1. **The terms resolver is price-complete.**
   `resolve_supplier_purchasing_terms(business, product, supplier, on_date,
   quantity, branch)` selects the applicable price break (highest `min_qty` at
   or below the quantity) and labels the result `tier` / `flat` / `none`.
   Tier `min_qty` is expressed in the **same unit as `min_order_qty`** (the
   purchase UoM), so price policy and quantity policy share one basis.
2. **One purchase price authority**: `resolve_purchase_line_price(...)`, with
   fixed precedence — active contract line → supplier tier → supplier standing
   price → product default cost → manual. It reuses the terms resolver rather
   than re-reading the table.
3. **Branch is part of the condition's identity.** Overlap is checked within a
   branch scope; a branch-specific row overrides the company-wide row for that
   branch and both may coexist.
4. **Writes are governed.** `upsert_supplier_item_terms` is the single write
   path: it routes price/currency/tier changes through `approval_route`
   (`supplier_terms.amend`, gated only where an org configures a rule), writes
   `audit_logs`, and publishes `procurement.supplier_terms.*` events on the
   existing outbox. Approval outcome is mirrored back onto
   `approval_status`; only `approved` rows resolve into a price.
5. **Provenance is snapshotted.** `purchase_order_items.supplier_terms_id` and
   `price_source` record which authority produced the agreed price; a price the
   operator overrode is honestly recorded as `manual`.
6. **One client seam** remains
   `src/features/products/purchasing/supplierPurchasingTerms.ts`; Purchases
   reaches it only through `purchasingTerms/purchaseLineTerms.ts`.

## Consequences

- Price breaks now change what a PO line costs; previously they were decoration.
- No surface may rank contract vs supplier price — that ranking is one server
  routine and a guard test fails if a browser file re-implements it.
- Historical purchase orders stay explainable after conditions change.

## Guards

- `supabase/tests/supplier_purchasing_conditions_test.sql`
- `supabase/tests/supplier_purchasing_terms_test.sql`
- `src/test/architecture/purchasing-terms-single-owner.test.ts`

## Out of scope

- Cross-currency comparison of competing supplier conditions (FX authority
  exists; the comparison UI does not yet consume it).
- Supplier-specific packaging hierarchies.
- Dropping the deprecated `products.min_order_quantity` /
  `order_quantity_increment` fallbacks.
