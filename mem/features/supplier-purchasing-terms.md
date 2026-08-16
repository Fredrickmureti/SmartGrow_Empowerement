---
name: supplier-owned-purchasing-terms
description: Supplier purchasing conditions (price, price breaks, MOQ, increment, purchase UoM, lead time) are owned by supplier_item_terms, resolved and enforced server-side, governed by the approval engine, and snapshotted onto PO lines.
type: constraint
---
- Purchasing conditions live on the supplier↔product relationship: `supplier_item_terms` (price, `price_break_tiers`, `order_increment`, `purchase_uom_id`, lead time). Effective-dated rows win over product-level defaults (ADR 0141/0142).
- ONE terms resolver: `resolve_supplier_purchasing_terms(business, product, supplier, on_date, quantity, branch)` — it applies price breaks (tier `min_qty` is in the purchase UoM, same basis as `min_order_qty`) and returns `price_source`.
- ONE purchase price authority: `resolve_purchase_line_price(...)` with fixed precedence contract → supplier tier → supplier flat → product default → manual. No browser file may rank these.
- ONE quantity enforcer: `validate_supplier_order_quantity(...)` → `BELOW_MIN_ORDER_QTY` / `NOT_ON_ORDER_INCREMENT` / `QUANTITY_NOT_POSITIVE`. All three functions SECURITY DEFINER, `authenticated` only.
- ONE write path: `upsert_supplier_item_terms` (single overload) — routes price/currency/tier changes through `approval_route('supplier_terms.amend')`, writes `audit_logs`, emits `procurement.supplier_terms.*` on the outbox. `approval_status` mirrors the request; only `approved` rows resolve into a price.
- Branch is part of the condition's identity: overlap is checked within a branch scope, and a branch row overrides the company-wide (NULL) row for that branch.
- `purchase_order_items.supplier_terms_id` + `price_source` snapshot which authority priced the line; an overridden price records as `manual`.
- Single client seam: `src/features/products/purchasing/supplierPurchasingTerms.ts`; Purchases reaches it only via `src/features/purchases/purchasingTerms/purchaseLineTerms.ts`. Guards: `src/test/architecture/purchasing-terms-single-owner.test.ts`, `supabase/tests/supplier_purchasing_conditions_test.sql`.
- The supplier argument accepts the purchasing party (`contacts.id`) or the supplier role (`suppliers.id`); the server does the hop. `useMOQValidation` is deleted and must never return.
- Price overrides are governed: `purchase_price_override_policies` (per business, tolerance abs/pct, require_reason, require_approval) is read by `_po_item_stamp_price_provenance`, which stamps `purchase_order_items.resolved_unit_price`, raises `PRICE_OVERRIDE_REASON_REQUIRED`, and routes `purchase_order.price_override`. The browser only collects the reason (`PriceOverrideReasons`) — never a tolerance.
- Coverage reporting is the read-only view `public.v_supplier_coverage` (uncovered / single_source / multi_source), consumed by `useSupplierCoverage`. No new engine.
- The workspace route is `/purchases/supplier-conditions` (legacy `/purchases/price-lists` redirects). Only that workspace reads inactive conditions, via `useVendorPriceLists(..., { includeInactive: true })`.
